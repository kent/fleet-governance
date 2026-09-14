/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { tsconfigPath: "tsconfig.next.json" },
  // Next 16's `next dev` otherwise writes apps/runner/AGENTS.md and apps/runner/CLAUDE.md on
  // every run (its own agent-rules feature); not part of this task's deliverables, so disabled
  // rather than left to recreate itself as an uncommitted diff on every future `next dev`.
  agentRules: false,
  // @fleet/schemas ships ESM without a build step other packages rely on; the browser bundle
  // (ConfigForm.tsx validates client-side with it) needs it transpiled like first-party source.
  transpilePackages: ["@fleet/schemas"],
  // pg is native-binding adjacent and only ever used server-side (src/lib/db.ts); keep it out of
  // the server bundle and required from node_modules at runtime instead.
  serverExternalPackages: ["pg"],
  // Every relative import in this app (route handlers, lib, components) is written with an
  // explicit ".js" extension pointing at a ".ts"/".tsx" source file, matching the CLI's own
  // NodeNext convention (controller notes: "relative imports with .js extensions, as the CLI
  // does") so the same source compiles under both apps/runner/tsconfig.json (NodeNext, which
  // requires the explicit extension) and tsconfig.next.json (bundler, which also accepts it).
  // `tsc` resolves ".js" -> ".ts"/".tsx" on its own under "moduleResolution": "bundler"; the
  // actual bundler `next build`/`next dev` invoke does not do this by default. Turbopack (Next
  // 16's default) has no equivalent of webpack's `resolve.extensionAlias` as of 16.3.5, so this
  // app pins webpack via `--webpack` on the dev/build/ui scripts and configures it here.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
