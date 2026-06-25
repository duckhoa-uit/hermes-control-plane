// Test shim: minimal DurableObject base class used by SessionDurableObject.
// In real workerd this is provided by the runtime; for in-process E2E we
// supply just what we need (ctx + env access).
export class DurableObject<Env = unknown> {
  protected ctx: any;
  protected env: Env;
  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
