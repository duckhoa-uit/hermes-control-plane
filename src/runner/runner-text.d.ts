// Wrangler bundles `sandbox-runner.ts.txt` as a text module so we can ship
// the runner source into the E2B sandbox at provision time.
declare module "*.txt" {
  const content: string;
  export default content;
}
