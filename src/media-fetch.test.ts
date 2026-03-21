import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchRemoteMedia, mediaFetchCache } from "./fetch.js";
import type { FetchLike } from "./fetch.js";

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingFetch(firstChunk: Uint8Array) {
  return vi.fn(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
        },
      }),
      { status: 200 },
    );
  });
}

describe("fetchRemoteMedia", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;

  beforeEach(() => {
    mediaFetchCache.clear();
  });

  it("rejects when content-length exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
        status: 200,
        headers: { "content-length": "5" },
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
        status: 200,
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("aborts stalled body reads when idle timeout expires", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = makeStallingFetch(new Uint8Array([1, 2]));

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn,
        maxBytes: 1024,
        readIdleTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "fetch_failed",
      name: "MediaFetchError",
    });
  }, 5_000);

  it("blocks private IP literals before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchRemoteMedia({
        url: "http://127.0.0.1/secret.jpg",
        fetchImpl,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns cached result on cache hit", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const result1 = await fetchRemoteMedia({
      url: "https://example.com/image.png",
      fetchImpl,
      lookupFn,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const result2 = await fetchRemoteMedia({
      url: "https://example.com/image.png",
      fetchImpl,
      lookupFn,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result2.buffer).toEqual(result1.buffer);
  });

  it("does not cache error responses", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/missing.png",
        fetchImpl,
        lookupFn,
      }),
    ).rejects.toThrow("404");

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/missing.png",
        fetchImpl,
        lookupFn,
      }),
    ).rejects.toThrow("404");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entry when cache exceeds max size", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = vi.fn(async (url: string | URL) =>
      new Response(makeStream([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    for (let i = 0; i < 502; i++) {
      await fetchRemoteMedia({
        url: `https://example.com/image${i}.png`,
        fetchImpl: fetchImpl as FetchLike,
        lookupFn,
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(502);

    const result503 = await fetchRemoteMedia({
      url: "https://example.com/image0.png",
      fetchImpl: fetchImpl as FetchLike,
      lookupFn,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(503);
    expect(result503.buffer).toBeInstanceOf(Buffer);
  });
});
