import { describe, expect, it } from "vitest";

import worker from "./index";

const uploadId = "Ab12Cd34";

interface ListedPage {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

/** In-memory R2 boundary used to exercise deletion through the Worker's fetch handler. */
class FakeBucket {
  readonly deletedBatches: string[][] = [];
  readonly listCalls: Array<{ prefix?: string; cursor?: string }> = [];
  failList = false;
  failDelete = false;

  constructor(private readonly pages: Record<string, ListedPage>) {}

  async list(options: { prefix?: string; cursor?: string }): Promise<ListedPage> {
    this.listCalls.push(options);
    if (this.failList) throw new Error("list failed");
    return this.pages[options.cursor ?? "first"] ?? { objects: [], truncated: false };
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this.failDelete) throw new Error("delete failed");
    this.deletedBatches.push(Array.isArray(keys) ? keys : [keys]);
  }
}

function request(path = `/upload/${uploadId}`, token = "secret"): Request {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return new Request(`https://docs.example${path}`, { method: "DELETE", headers });
}

function environment(bucket: FakeBucket): { DOCS_BUCKET: R2Bucket; AUTH_TOKEN: string } {
  return { DOCS_BUCKET: bucket as unknown as R2Bucket, AUTH_TOKEN: "secret" };
}

describe("DELETE /upload/:id", () => {
  it("deletes every paginated object in R2-sized batches", async () => {
    const firstKeys = Array.from({ length: 1000 }, (_, index) => `${uploadId}/part-${index}`);
    const remainingKeys = [`${uploadId}/part-1000`, `${uploadId}/part-1001`];
    const bucket = new FakeBucket({
      first: {
        objects: firstKeys.map((key) => ({ key })),
        truncated: true,
        cursor: "next-page",
      },
      "next-page": {
        objects: remainingKeys.map((key) => ({ key })),
        truncated: false,
      },
    });

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(204);
    expect(bucket.listCalls).toEqual([
      { prefix: `${uploadId}/`, cursor: undefined },
      { prefix: `${uploadId}/`, cursor: "next-page" },
    ]);
    expect(bucket.deletedBatches).toEqual([firstKeys, remainingKeys]);
  });

  it("returns not found without deleting when the ID has no objects", async () => {
    const bucket = new FakeBucket({ first: { objects: [], truncated: false } });

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(404);
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("rejects missing or invalid bearer authentication before accessing R2", async () => {
    for (const token of ["", "wrong-token"]) {
      const bucket = new FakeBucket({ first: { objects: [{ key: `${uploadId}/report.html` }], truncated: false } });

      const response = await worker.fetch(request(`/upload/${uploadId}`, token), environment(bucket));

      expect(response.status).toBe(401);
      expect(bucket.listCalls).toEqual([]);
    }
  });

  it("rejects malformed IDs and filename-bearing paths without accessing R2", async () => {
    for (const path of ["/upload/short", `/upload/${uploadId}/report.html`]) {
      const bucket = new FakeBucket({ first: { objects: [{ key: `${uploadId}/report.html` }], truncated: false } });

      const response = await worker.fetch(request(path), environment(bucket));

      expect(response.status).toBe(404);
      expect(bucket.listCalls).toEqual([]);
    }
  });

  it("returns a storage error when listing fails", async () => {
    const bucket = new FakeBucket({});
    bucket.failList = true;

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Storage error");
  });

  it("returns a storage error when deletion fails", async () => {
    const bucket = new FakeBucket({
      first: { objects: [{ key: `${uploadId}/report.html` }], truncated: false },
    });
    bucket.failDelete = true;

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Storage error");
  });
});
