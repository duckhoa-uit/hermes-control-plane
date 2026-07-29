import { describe, expect, it } from "vitest";
import { withCustomSpan } from "../src/core/tracing";

function tracer() {
  const spans: Array<{ name: string; attributes: Record<string, unknown>; ended: boolean }> = [];
  return {
    spans,
    tracing: {
      enterSpan(name: string, callback: (span: unknown) => unknown) {
        const record: { name: string; attributes: Record<string, unknown>; ended: boolean } = {
          name,
          attributes: {},
          ended: false,
        };
        spans.push(record);
        try {
          const result = callback({
            setAttribute(key: string, value: unknown) {
              record.attributes[key] = value;
            },
            end() {
              record.ended = true;
            },
          });
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).finally(() => {
              record.ended = true;
            });
          }
          record.ended = true;
          return result;
        } catch (error) {
          record.ended = true;
          throw error;
        }
      },
    } as never,
  };
}

describe("Cloudflare custom spans", () => {
  it("records success attributes and closes the span", async () => {
    const fake = tracer();
    await expect(
      withCustomSpan(
        fake.tracing,
        "control_plan.test",
        { "control_plan.task_id": "task-1" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
    expect(fake.spans).toEqual([
      {
        name: "control_plan.test",
        attributes: {
          "control_plan.task_id": "task-1",
          "control_plan.status": "ok",
        },
        ended: true,
      },
    ]);
  });

  it("records error metadata and still closes the span", async () => {
    const fake = tracer();
    await expect(
      withCustomSpan(fake.tracing, "control_plan.test", {}, async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.spans[0]).toMatchObject({
      attributes: {
        "control_plan.status": "error",
        "error.type": "TypeError",
        "error.message": "boom",
      },
      ended: true,
    });
  });

  it("does not change behavior when tracing is unavailable", async () => {
    await expect(withCustomSpan(undefined, "control_plan.test", {}, () => 42)).resolves.toBe(42);
  });
});
