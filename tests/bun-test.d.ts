declare module "bun:test" {
  type MaybePromise<T> = T | Promise<T>;

  export function test(name: string, fn: () => MaybePromise<void>): void;
}
