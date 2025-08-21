# Database Rules

## Database Rule 1: Zod Validation for External Inputs
Use `zod` for schema validation of all external inputs for type-safe, declarative runtime validation

- Always validate user input (commands, API requests, forms) with Zod
- Use Zod for any data coming from untrusted or external sources
- For database output, rely on TypeScript types unless:
  - The data is dynamic (e.g., JSON columns)
  - The data comes from a migration/seed or legacy source that might be malformed
  - You want extra safety for critical operations

```ts
// ✅ DO (user input)
const userSchema = z.object({ id: z.string() });
const parsed = userSchema.parse(input);

// ✅ DO (dynamic DB output)
const configSchema = z.object({ settings: z.record(z.string(), z.any()) });
const config = configSchema.parse(dbRow.settings);

// ❌ DON'T (static, trusted DB output)
const [user] = await sql`SELECT * FROM users WHERE id = ${id}`; // TypeScript types are enough
```

## Database Rule 2: Bun SQL Template Literals
Use Bun's sql template literals and .file() for all database queries and schema execution

- Use `sql\`SELECT ...\`` for queries and `sql.file()` for schema execution
- Prefer tagged template literals for parameterized queries to prevent SQL injection
- Use `.unsafe()` only for static, trusted SQL (e.g., schema files)
- Arrays are automatically converted - simply pass JavaScript arrays directly
- Do not use type parameters with sql<Type> - rely on TypeScript inference and Zod validation

```ts
// ✅ DO
import { sql } from "bun";
const users = await sql`SELECT * FROM users WHERE active = ${true}`;
await sql.file("src/db/tomoribotSchema.sql");
const [user] = await sql`SELECT * FROM users WHERE id = ${userId}`;
await sql`INSERT INTO tags (names) VALUES (${tagArray})`;

// ❌ DON'T
const users = await sql<UserRow[]>`SELECT * FROM users`;
await sql`INSERT INTO tags (names) VALUES (${sql.array(tagArray)})`;
await sql.unsafe("SELECT * FROM " + userInput); // unsafe with user input!
```

## Database Rule 3: Schema Organization
Co-locate Zod schemas and inferred types for DB rows in types/db/schema.ts

- Define Zod schemas for each DB row/table in types/db/schema.ts
- Use `z.infer<typeof schema>` to export the TypeScript type
- Always import both the schema and the type where needed
- Use schema.partial() directly for validating partial updates
- Only define separate update schema if you need custom logic

```ts
// ✅ DO (in types/db/schema.ts)
export const llmSchema = z.object({ ... });
export type LlmRow = z.infer<typeof llmSchema>;

// In other files
import { llmSchema, type LlmRow } from "../types/db";

// For updates
userSchema.partial().parse(updatePayload);

// ❌ DON'T
export interface LlmRow { ... }
// and separately
const llmSchema = z.object({ ... });
```

## Database Rule 4: Non-null Assertions
Use non-null assertions with explicit biome-ignore comments only when database logic guarantees presence

- Use the non-null assertion operator (`!`) only when you have already checked for presence
- Always add a `// biome-ignore lint/style/noNonNullAssertion:` comment explaining why safe
- Do not use non-null assertions elsewhere; prefer explicit checks or type guards
- Do not disable the lint rule globally—suppress only for justified, documented cases

```ts
// ✅ DO
if (existingServer) {
  // biome-ignore lint/style/noNonNullAssertion: Existing data object guarantees id is present
  serverId = existingServer.server_id!;
}

// ❌ DON'T
serverId = maybeServer.server_id!; // no presence check, unsafe
```

## Database Rule 5: UPSERT with RETURNING
Use UPSERT with RETURNING for insert/update operations for atomic operations and reduced round trips

```ts
// ✅ DO
const [userData] = await sql`
    INSERT INTO users (user_id, name)
    VALUES (${userId}, ${name})
    ON CONFLICT (user_id) DO UPDATE
    SET name = EXCLUDED.name
    RETURNING *
`;
const validUser = userSchema.parse(userData);

// ❌ DON'T
const [existingUser] = await sql`SELECT * FROM users WHERE user_id = ${userId}`;
if (existingUser) {
    await sql`UPDATE users SET name = ${name} WHERE user_id = ${userId}`;
} else {
    await sql`INSERT INTO users (user_id, name) VALUES (${userId}, ${name})`;
}
```

## Database Rule 6: PostgreSQL Best Practices
Use standard PostgreSQL patterns with Bun's sql template literals

- Use EXISTS instead of COUNT(*) for existence checks
- Use table aliases in JOINs for readability
- Use SELECT columns explicitly instead of * when possible
- Properly handle array columns with appropriate operators

```ts
// ✅ DO
import { sql } from "bun";

// Existence check
const exists = await sql`
  SELECT 1 FROM users u
  WHERE u.user_id = ${id}
  LIMIT 1
`;

// Array operations
await sql`
  SELECT * FROM items 
  WHERE tags && ${tagArray} -- array overlap
  AND category = ANY(${categoryArray}) -- array contains
`;

// ❌ DON'T
// Don't use COUNT(*) just to check existence
const [{ count }] = await sql`
  SELECT COUNT(*) FROM users 
  WHERE user_id = ${id}
`;
```

## Database Rule 7: Session Helpers
Use session helpers for all database state management for consistent state handling and type safety

- Use centralized session helpers from session.ts for database state
- Get tomori/user state via helper functions
- Use proper error handling and type validation
- Follow the established patterns for new state queries

```ts
// ✅ DO
const tomoriState = await loadTomoriState(serverId);
if (!tomoriState) {
    log.error("Tomori not initialized for server");
    return;
}

const userState = await loadUserState(userId);
if (!userState) {
    await interaction.reply("Please register first!");
    return;
}

// ❌ DON'T
// Don't write ad-hoc queries
const [row] = await sql`SELECT * FROM tomori WHERE server_id = ${serverId}`;
const config = await sql`SELECT * FROM tomori_config WHERE tomori_id = ${row.id}`;

// Don't skip error handling
const state = await loadTomoriState(serverId);
await doSomething(state); // state might be null!
```

## Database Rule 8: Error Logging with Context
Use `log.error` with context for database logging to centralize error tracking and provide structured debugging context

- When an error occurs that should be tracked, use `await log.error(message, error, context)`
- Pass the caught `error` object as the second argument
- Provide optional `context` object (`ErrorContext`) with relevant information:
  - `userId`: Internal database `user_id` (from `UserRow`)
  - `serverId`: Internal database `server_id` (from `ServerRow`) 
  - `tomoriId`: Internal database `tomori_id` (from `TomoriRow`)
  - `errorType`: Concise categorization string
  - `metadata`: Useful, non-redundant debugging information
- Use `log.warn` for potential issues or expected "errors" handled gracefully

```ts
// ✅ DO (Error during command execution)
const context: ErrorContext = {
  userId: userData.user_id,
  serverId: serverData.server_id,
  errorType: 'CommandExecutionError',
  metadata: {
    commandName: interaction.commandName,
    options: interaction.options?.data,
    step: 'processingUserData',
  }
};
await log.error(`Failed command: ${interaction.commandName}`, error, context);

// ❌ DON'T (Including redundant Discord IDs in metadata)
const context: ErrorContext = {
  userId: userData.user_id,
  metadata: {
    userDiscordId: interaction.user.id, // Redundant if userId is present
    commandName: interaction.commandName,
  }
};
```

## Database Rule 9: PostgreSQL Array Operations
Use PostgreSQL native functions for atomic array operations and formatted literals for full replacements

- For appending: Use `array_append(column, element)` - atomic at database level
- For removing: Use `array_remove(column, element)` - atomic operation
- For full replacement: Use properly escaped PostgreSQL array literals with `::text[]` cast

```ts
// ✅ DO (Appending)
UPDATE users
SET personal_memories = array_append(personal_memories, ${newMemory})
WHERE user_id = ${userId}
RETURNING *;

// ✅ DO (Removing)
UPDATE users
SET personal_memories = array_remove(personal_memories, ${memoryToRemove})
WHERE user_id = ${userId}
RETURNING *;

// ✅ DO (Full array replacement)
const arrayLiteral = `{${updatedMemories
  .map((item) => `"${item.replace(/([\"\\])/g, "\\$1")}"`) // Ensures proper escaping
  .join(",")}}`;

await sql`
  UPDATE users
  SET personal_memories = ${arrayLiteral}::text[]
  WHERE user_id = ${userId}
  RETURNING *;
`;
```