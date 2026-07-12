using Xunit;

// ActiveRowLimit is a process-global static on QueryExecutor, and the truncation
// tests mutate it. Run this assembly's tests sequentially so parallel classes
// can't race that shared state — and so only one database container is up at a
// time, keeping the runner's memory footprint sane.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
