// Example of a local non-blocking hook. Disabled in profiles/hooks.example.json.
// Replace with your own validation before enabling as a blocking hook.
let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
JSON.parse(input);
process.stdout.write(JSON.stringify({ allow: true }) + "\n");