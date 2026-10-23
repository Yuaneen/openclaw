import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const lanceMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectClose: vi.fn(),
  tableClose: vi.fn(),
  tableNames: vi.fn(async () => ["memories"]),
  schema: vi.fn(async () => ({ fields: [{ name: "agentId" }] })),
  add: vi.fn(async () => undefined),
  deleteRows: vi.fn(async () => ({ numDeletedRows: 1 })),
}));

vi.mock("./lancedb-runtime.js", () => ({
  loadLanceDbModule: vi.fn(async () => ({
    connect: lanceMocks.connect,
  })),
}));

import { MemoryDB } from "./lancedb-store.js";

function makeTableHandle() {
  return {
    checkoutLatest: vi.fn(async () => undefined),
    schema: lanceMocks.schema,
    add: lanceMocks.add,
    delete: lanceMocks.deleteRows,
    vectorSearch: () => ({
      where: () => ({ limit: () => ({ toArray: vi.fn(async () => []) }) }),
    }),
    query: () => ({
      where: () => ({ select: () => ({ toArray: vi.fn(async () => []) }) }),
    }),
    close: lanceMocks.tableClose,
  };
}

function makeDbHandle() {
  return {
    tableNames: lanceMocks.tableNames,
    openTable: vi.fn(async () => makeTableHandle()),
    createEmptyTable: vi.fn(async () => makeTableHandle()),
    close: lanceMocks.connectClose,
  };
}

let db: MemoryDB;
beforeEach(() => {
  vi.clearAllMocks();
  lanceMocks.connect.mockResolvedValue(makeDbHandle());
  db = new MemoryDB("/unused", 3);
});
afterEach(async () => {
  await db.close();
});

describe("MemoryDB close lifecycle is terminal", () => {
  test("initialization completing after close publishes no handle and releases it", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      return makeDbHandle();
    });

    const pending = db.store("alpha", {
      text: "racing entry",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });

    // Let the store reach the awaiting connect before closing.
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    // close() awaits the in-flight initialization; resolve the gate so the
    // initializer can observe the closed instance and reject its handle.
    const closing = db.close();
    gate.resolve();

    // The admitted store must not commit through a handle published after close.
    await expect(pending).rejects.toThrow(/closed/i);
    await closing;

    await vi.waitFor(() => expect(lanceMocks.connectClose).toHaveBeenCalled());
    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.add).not.toHaveBeenCalled();
  });

  test("operations admitted during close wait and then re-initialize cleanly", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      return makeDbHandle();
    });

    // Start a store that is awaiting initialization, then close while it is in flight.
    const pending = db.store("alpha", {
      text: "during close",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    const closing = db.close();
    gate.resolve();
    await expect(pending).rejects.toThrow(/closed/i);
    await closing;

    // A later operation on the same instance starts a fresh lifecycle generation
    // instead of writing through a stale handle.
    lanceMocks.connect.mockResolvedValue(makeDbHandle());
    await expect(db.store("beta", {
      text: "after close",
      vector: [0, 1, 0],
      importance: 0.5,
      category: "fact",
    })).resolves.toMatchObject({ text: "after close" });
    expect(lanceMocks.add).toHaveBeenCalledTimes(1);
  });

  test("close is idempotent across repeated calls", async () => {
    await expect(db.close()).resolves.toBeUndefined();
    await expect(db.close()).resolves.toBeUndefined();
    await expect(db.close()).resolves.toBeUndefined();
  });

  test("successful close releases an initialized handle exactly once", async () => {
    await db.store("alpha", {
      text: "seeded",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await db.close();
    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
  });

  test("concurrent close calls share one lifecycle and close handles once", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      return makeDbHandle();
    });

    const pending = db.store("alpha", {
      text: "concurrent race",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    const closeA = db.close();
    const closeB = db.close();
    const closeC = db.close();
    gate.resolve();

    await expect(pending).rejects.toThrow(/closed/i);
    await Promise.all([closeA, closeB, closeC]);

    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
  });

  test("close swallows an in-flight initialization failure and still settles", async () => {
    lanceMocks.connect.mockRejectedValueOnce(new Error("native connect failed"));

    const pending = db.store("alpha", {
      text: "failing init",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    // Pre-register the rejection handler so the racing close below cannot leave
    // the store's rejection unhandled while Vitest watches the microtask queue.
    const pendingSettled = pending.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    await expect(db.close()).resolves.toBeUndefined();
    expect(await pendingSettled).toContain("native connect failed");
  });

  test("repeated close/re-open cycles keep the store usable across generations", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      lanceMocks.connect.mockResolvedValue(makeDbHandle());
      await db.store("alpha", {
        text: `cycle ${cycle}`,
        vector: [1, 0, 0],
        importance: 0.5,
        category: "fact",
      });
      await db.close();
    }
    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(3);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(3);
  });
});
