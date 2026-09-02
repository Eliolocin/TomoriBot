async function main(): Promise<void> {
  process.env.RUN_ENV = "production";
  const { COMMAND_REFERENCE_PATH, writeCommandReference } = await import("../lib/commandReference");

  await writeCommandReference();
  console.log(`Command reference generated: ${COMMAND_REFERENCE_PATH}`);
  // Loading the command graph leaves an open handle, so a run that falls off the end of main() never
  // exits. The stale branch already exits explicitly; the success branch must too, or a passing check
  // hangs and its runner reports the kill as a failure.
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
