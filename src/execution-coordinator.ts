import { AsyncLocalStorage } from "node:async_hooks";
import type { Bot } from "mineflayer";
import { createActor, createMachine } from "xstate";

export type ExecutionOwner =
  | "combat"
  | "recovery"
  | "food"
  | "storage"
  | "work"
  | "project";

type ExecutionState = "idle" | ExecutionOwner;

type CoordinatorEvent =
  | { type: "IDLE" }
  | { type: "COMBAT" }
  | { type: "RECOVERY" }
  | { type: "FOOD" }
  | { type: "STORAGE" }
  | { type: "WORK" }
  | { type: "PROJECT" };

const OWNER_PRIORITY: Record<ExecutionState, number> = {
  idle: 0,
  project: 1,
  work: 2,
  storage: 3,
  food: 4,
  recovery: 5,
  combat: 6
};

const MUTATING_PATHFINDER_METHODS = new Set([
  "goto",
  "setGoal",
  "setMovements",
  "stop"
]);

const executionMachine = createMachine({
  types: {} as { events: CoordinatorEvent },
  id: "execution",
  initial: "idle",
  states: {
    idle: { on: transitions() },
    combat: { on: transitions() },
    recovery: { on: transitions() },
    food: { on: transitions() },
    storage: { on: transitions() },
    work: { on: transitions() },
    project: { on: transitions() }
  }
});

export interface ExecutionScope {
  run(task: () => Promise<void>): Promise<boolean>;
  runSync(task: () => void): boolean;
  claim(): boolean;
  release(): void;
}

/**
 * Owns executor priority and enforces that every Pathfinder mutation happens
 * inside the currently-authorized executor scope.
 */
export class ExecutionCoordinator {
  private readonly ownerContext = new AsyncLocalStorage<ExecutionOwner>();
  private readonly actor = createActor(executionMachine);
  private readonly rawPathfinder: Bot["pathfinder"];
  private readonly guardedPathfinder: Bot["pathfinder"];
  private disposed = false;

  constructor(private readonly bot: Bot) {
    this.rawPathfinder = bot.pathfinder;
    this.guardedPathfinder = this.createPathfinderGuard(this.rawPathfinder);
    this.actor.start();
    bot.pathfinder = this.guardedPathfinder;
  }

  owner(): ExecutionState {
    return this.actor.getSnapshot().value as ExecutionState;
  }

  scope(owner: ExecutionOwner, retain: () => boolean): ExecutionScope {
    return {
      run: async (task) => {
        if (retain() && !this.claim(owner)) return false;
        return this.ownerContext.run(owner, async () => {
          try {
            await task();
            return true;
          } finally {
            if (!retain()) this.release(owner);
          }
        });
      },
      runSync: (task) => {
        if (retain() && !this.claim(owner)) return false;
        return this.ownerContext.run(owner, () => {
          try {
            task();
            return true;
          } finally {
            if (!retain()) this.release(owner);
          }
        });
      },
      claim: () => this.claim(owner),
      release: () => this.release(owner)
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rawPathfinder.stop();
    this.bot.pathfinder = this.rawPathfinder;
    this.actor.stop();
  }

  private claim(owner: ExecutionOwner): boolean {
    const current = this.owner();
    if (current === owner) return true;
    if (OWNER_PRIORITY[owner] <= OWNER_PRIORITY[current]) return false;
    if (current !== "idle") this.rawPathfinder.stop();
    this.actor.send({ type: owner.toUpperCase() as Uppercase<ExecutionOwner> });
    return this.owner() === owner;
  }

  private release(owner: ExecutionOwner): void {
    if (this.owner() !== owner) return;
    this.rawPathfinder.stop();
    this.actor.send({ type: "IDLE" });
  }

  private createPathfinderGuard(pathfinder: Bot["pathfinder"]): Bot["pathfinder"] {
    return new Proxy(pathfinder, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (!MUTATING_PATHFINDER_METHODS.has(String(property))) {
          return value.bind(target);
        }
        return (...args: unknown[]) => {
          const caller = this.ownerContext.getStore();
          if (!caller) {
            throw new Error(
              `Pathfinder.${String(property)} requires an execution-owner scope`
            );
          }
          if (!this.claim(caller)) {
            throw new Error(
              `Pathfinder.${String(property)} denied for ${caller}; ` +
                `${this.owner()} owns movement`
            );
          }
          return Reflect.apply(value, target, args);
        };
      }
    }) as Bot["pathfinder"];
  }
}

function transitions() {
  return {
    IDLE: "idle",
    COMBAT: "combat",
    RECOVERY: "recovery",
    FOOD: "food",
    STORAGE: "storage",
    WORK: "work",
    PROJECT: "project"
  } as const;
}
