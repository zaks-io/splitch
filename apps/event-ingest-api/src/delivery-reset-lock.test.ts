import { describe, expect, it } from "vitest";
import { DeliveryResetLock } from "./delivery-reset-lock";

/** A promise plus the handle that settles it, so a test can hold a section open. */
function gate() {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const held = new Promise<void>((resolve, reject) => {
    open = () => {
      resolve();
    };
    fail = reject;
  });
  return { held, open, fail };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DeliveryResetLock", () => {
  it("runs shared sections concurrently", async () => {
    const lock = new DeliveryResetLock();
    const first = gate();
    const second = gate();
    const entered: string[] = [];

    const running = Promise.all([
      lock.shared(async () => {
        entered.push("first");
        await first.held;
      }),
      lock.shared(async () => {
        entered.push("second");
        await second.held;
      }),
    ]);
    await settle();

    expect(entered, "the second delivery waited on the first").toEqual(["first", "second"]);
    first.open();
    second.open();
    await running;
  });

  it("holds an exclusive section until every admitted shared section drains", async () => {
    const lock = new DeliveryResetLock();
    const delivery = gate();
    let resetRan = false;

    const running = lock.shared(() => delivery.held);
    await settle();
    const reset = lock.exclusive(async () => {
      resetRan = true;
    });
    await settle();

    expect(resetRan, "the reset purged while a delivery was still in flight").toBe(false);
    delivery.open();
    await running;
    await reset;
    expect(resetRan).toBe(true);
  });

  it("makes a shared section wait for a pending exclusive one", async () => {
    const lock = new DeliveryResetLock();
    const reset = gate();
    let deliveryRan = false;

    const running = lock.exclusive(() => reset.held);
    const delivery = lock.shared(async () => {
      deliveryRan = true;
    });
    await settle();

    expect(deliveryRan, "a delivery overtook a reset that already claimed the lock").toBe(false);
    reset.open();
    await running;
    await delivery;
    expect(deliveryRan).toBe(true);
  });

  it("prefers writers so a steady stream of deliveries cannot starve a reset", async () => {
    const lock = new DeliveryResetLock();
    const reset = gate();
    const order: string[] = [];

    const first = lock.shared(async () => {
      order.push("delivery-before");
    });
    await settle();
    const purge = lock.exclusive(async () => {
      order.push("reset");
      await reset.held;
    });
    const later = lock.shared(async () => {
      order.push("delivery-after");
    });
    await settle();
    reset.open();
    await Promise.all([first, purge, later]);

    expect(order).toEqual(["delivery-before", "reset", "delivery-after"]);
  });

  it("serializes exclusive sections against each other", async () => {
    const lock = new DeliveryResetLock();
    const first = gate();
    const order: string[] = [];

    const running = lock.exclusive(async () => {
      order.push("first");
      await first.held;
    });
    const second = lock.exclusive(async () => {
      order.push("second");
    });
    await settle();

    expect(order).toEqual(["first"]);
    first.open();
    await Promise.all([running, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it.each([
    ["shared", (lock: DeliveryResetLock, run: () => Promise<void>) => lock.shared(run)],
    ["exclusive", (lock: DeliveryResetLock, run: () => Promise<void>) => lock.exclusive(run)],
  ])("releases the lock when a %s section rejects", async (_kind, enter) => {
    const lock = new DeliveryResetLock();
    const failure = new Error("section failed");

    await expect(
      enter(lock, () => Promise.reject(failure)),
      "the rejection was swallowed instead of reaching the caller",
    ).rejects.toBe(failure);
    await expect(lock.exclusive(() => Promise.resolve())).resolves.toBeUndefined();
    await expect(lock.shared(() => Promise.resolve())).resolves.toBeUndefined();
  });

  it("lets a delivery through after a failed reset releases", async () => {
    const lock = new DeliveryResetLock();
    const reset = gate();
    let deliveryRan = false;

    const purge = lock.exclusive(() => reset.held);
    const delivery = lock.shared(async () => {
      deliveryRan = true;
    });
    reset.fail(new Error("reset failed"));

    await expect(purge).rejects.toThrow("reset failed");
    await delivery;
    expect(deliveryRan, "a failed reset wedged the lock shut").toBe(true);
  });
});
