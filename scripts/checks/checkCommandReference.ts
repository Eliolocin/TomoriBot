async function main(): Promise<void> {
  process.env.RUN_ENV = "production";
  const { COMMAND_REFERENCE_PATH, generateCommandReferenceMarkdown } = await import("../lib/commandReference");

  const expected = await generateCommandReferenceMarkdown();
  const current = await Bun.file(COMMAND_REFERENCE_PATH).text();

  if (current === expected) {
    console.log("Command reference OK");
    // Loading the command graph leaves an open handle, so a run that falls off the end of main() never
    // exits. The stale branch already exits explicitly; the success branch must too, or a passing check
    // hangs and its runner reports the kill as a failure.
    process.exit(0);
  }

  console.error(
    "Command reference is stale. Run `bun run generate-command-reference` and commit docs/en/features/command-reference.md.",
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
