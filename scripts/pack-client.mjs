import { mkdir, copyFile, writeFile } from "node:fs/promises";
const dir = new URL("../.local/client/", import.meta.url);
await mkdir(dir, { recursive: true });
for (const name of ["index.js", "index.d.ts"])
  await copyFile(
    new URL(`../dist/packages/client/src/${name}`, import.meta.url),
    new URL(name, dir),
  );
await writeFile(
  new URL("package.json", dir),
  JSON.stringify(
    {
      name: "@equalfi/agent-client",
      version: "0.1.1",
      type: "module",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
      files: ["index.js", "index.d.ts"],
    },
    null,
    2,
  ),
);
process.stdout.write(`${dir.pathname}\n`);
