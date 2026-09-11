---
title: "Modal Input Components"
---

Discord introduced new interactive input components for modals beyond the original Text Input. These components enable richer form-like experiences with structured selection inputs.

## Overview

| Type | Name                              | Description                                           | Container |
| ---- | --------------------------------- | ----------------------------------------------------- | --------- |
| 4    | [Text Input](#text-input)         | Free-form text entry (original modal input)           | Action Row or Label |
| 5    | [User Select](#user-select)       | Select a user from the server or client context       | Label     |
| 6    | [Role Select](#role-select)       | Select a role from the server context                  | Label     |
| 8    | [Channel Select](#channel-select) | Select a channel from the server context              | Label     |
| 18   | [Label](#label)                   | Wrapper component for new modal inputs                | —         |
| 21   | [Radio Group](#radio-group)       | Select exactly one option from a list                 | Label     |
| 22   | [Checkbox Group](#checkbox-group) | Select one or many options from a list                | Label     |
| 23   | [Checkbox](#checkbox)             | Single yes/no toggle                                  | Label     |

### Key Differences from Message Components

- **Label wrapper required for structured inputs**: Radio Group, Checkbox Group, Checkbox, User Select, Role Select, and Channel Select must be placed inside a Label component (type 18), _not_ an Action Row. Text Inputs can use the older Action Row layout; TomoriBot's raw modal path wraps them in Labels so the same form can carry descriptions and structured inputs.
- **Modal-only**: These components are only available in modals — they cannot be used in message payloads.
- **Submit data structure**: The interaction response nests the input component inside the Label's `component` field, not in an `ActionRow.components` array.

---

## Label

A Label is a container component for wrapping new modal input types. It provides a visible label and optional description above the input.

Labels are analogous to Action Rows for Text Inputs, but designed specifically for the newer input components.

### Label Structure

| Field        | Type      | Description                                      |
| ------------ | --------- | ------------------------------------------------ |
| type         | integer   | `18` for label                                   |
| id?          | integer   | Optional identifier for component                |
| label        | string    | Text displayed above the input                   |
| description? | string    | Optional description text displayed below label  |
| component    | component | The input component (Radio Group, Checkbox Group, or Checkbox) |

---

## Radio Group

A Radio Group allows the user to select **exactly one** option from a defined list. Useful for mutually exclusive choices like provider selection, mode switches, or preference settings.

### Radio Group Structure

| Field      | Type                         | Description                                                      |
| ---------- | ---------------------------- | ---------------------------------------------------------------- |
| type       | integer                      | `21` for radio group                                             |
| id?        | integer                      | Optional identifier for component                                |
| custom_id  | string                       | Developer-defined identifier for the input; 1-100 characters     |
| options    | array of radio group options | List of options to show; min 2, max 10                           |
| required?  | boolean                      | Whether a selection is required to submit the modal (default: true) |

### Radio Group Option Structure

| Field        | Type    | Description                                              |
| ------------ | ------- | -------------------------------------------------------- |
| value        | string  | Dev-defined value of the option; max 100 characters      |
| label        | string  | User-facing label of the option; max 100 characters      |
| description? | string  | Optional description for the option; max 100 characters  |
| default?     | boolean | Shows the option as selected by default                  |

### Radio Group Interaction Response

| Field     | Type    | Description                                                          |
| --------- | ------- | -------------------------------------------------------------------- |
| type      | integer | `21` for a Radio Group                                               |
| id        | integer | Unique identifier for the component                                  |
| custom_id | string  | Developer-defined identifier for the input; 1-100 characters         |
| value     | ?string | The value of the selected option, or `null` if no option is selected |

### Modal Payload Example

```json
{
  "type": 9,
  "data": {
    "custom_id": "class_selection_modal",
    "title": "Class Selection",
    "components": [
      {
        "type": 18,
        "label": "Choose your class",
        "description": "Your class determines the style of play for your character.",
        "component": {
          "type": 21,
          "custom_id": "class_radio",
          "options": [
            {"value": "warrior", "label": "Warrior", "description": "Strong and brave"},
            {"value": "rogue", "label": "Rogue", "description": "Weak and squishy"},
            {"value": "wizard", "label": "Wizard", "description": "Nerd"},
            {"value": "bard", "label": "Bard", "description": "Annoys everyone"},
            {"value": "witch_doctor", "label": "Witch Doctor", "description": "Actually a pretty cool option"}
          ]
        }
      }
    ]
  }
}
```

### Submit Interaction Data Example

```json
{
  "type": 5,
  "data": {
    "custom_id": "class_selection_modal",
    "components": [
      {
        "id": 1,
        "type": 18,
        "component": {
          "custom_id": "class_radio",
          "id": 2,
          "type": 21,
          "value": "warrior"
        }
      }
    ]
  }
}
```

---

## Checkbox Group

A Checkbox Group allows the user to select **one or many** options from a list. Ideal for multi-select scenarios like capability toggles, feature flags, or day-of-week selection.

### Checkbox Group Structure

| Field       | Type                             | Description                                                                           |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| type        | integer                          | `22` for checkbox group                                                               |
| id?         | integer                          | Optional identifier for component                                                     |
| custom_id   | string                           | Developer-defined identifier for the input; 1-100 characters                          |
| options     | array of checkbox group options  | List of options to show; min 1, max 10                                                |
| min_values? | integer                          | Minimum items that must be chosen; min 0, max 10 (default: 1); if 0, `required` must be false |
| max_values? | integer                          | Maximum items that can be chosen; min 1, max 10 (default: number of options)          |
| required?   | boolean                          | Whether selecting within the group is required (default: true)                        |

### Checkbox Group Option Structure

| Field        | Type    | Description                                              |
| ------------ | ------- | -------------------------------------------------------- |
| value        | string  | Dev-defined value of the option; max 100 characters      |
| label        | string  | User-facing label of the option; max 100 characters      |
| description? | string  | Optional description for the option; max 100 characters  |
| default?     | boolean | Shows the option as selected by default                  |

### Checkbox Group Interaction Response

| Field     | Type             | Description                                                                      |
| --------- | ---------------- | -------------------------------------------------------------------------------- |
| type      | integer          | `22` for a Checkbox Group                                                        |
| id        | integer          | Unique identifier for the component                                              |
| custom_id | string           | Developer-defined identifier for the input; 1-100 characters                     |
| values    | array of strings | The values of the selected options, or `[]` if no options are selected           |

### Modal Payload Example

```json
{
  "type": 9,
  "data": {
    "custom_id": "day_selection_modal",
    "title": "Study Days",
    "components": [
      {
        "type": 18,
        "label": "Which days are you free?",
        "description": "Choose all of the days you're able to meet up.",
        "component": {
          "type": 22,
          "custom_id": "event_checkbox",
          "options": [
            {"value": "march-4", "label": "March 4th"},
            {"value": "march-5", "label": "March 5th"},
            {"value": "march-7", "label": "March 7th", "description": "I know this is a Saturday and is tough"},
            {"value": "march-9", "label": "March 9th"},
            {"value": "march-10", "label": "March 10th"}
          ]
        }
      }
    ]
  }
}
```

### Submit Interaction Data Example

```json
{
  "type": 5,
  "data": {
    "custom_id": "day_selection_modal",
    "components": [
      {
        "id": 1,
        "type": 18,
        "component": {
          "custom_id": "event_checkbox",
          "id": 2,
          "type": 22,
          "values": [
            "march-5",
            "march-10",
            "march-4"
          ]
        }
      }
    ]
  }
}
```

---

## Checkbox

A Checkbox is a single toggle for simple yes/no questions. Unlike Checkbox Group (which provides a list of options), a standalone Checkbox is a single binary input.

### Checkbox Structure

| Field     | Type    | Description                                                  |
| --------- | ------- | ------------------------------------------------------------ |
| type      | integer | `23` for checkbox                                            |
| id?       | integer | Optional identifier for component                            |
| custom_id | string  | Developer-defined identifier for the input; 1-100 characters |
| default?  | boolean | Whether the checkbox is selected by default                  |

> **Note:** Checkboxes cannot be set as `required`. To achieve required single-option behavior, use a Checkbox Group with one option and `required: true`.

### Checkbox Interaction Response

| Field     | Type    | Description                                                  |
| --------- | ------- | ------------------------------------------------------------ |
| type      | integer | `23` for a Checkbox                                          |
| id        | integer | Unique identifier for the component                          |
| custom_id | string  | Developer-defined identifier for the input; 1-100 characters |
| value     | boolean | The state of the checkbox (`true` if checked, `false` if unchecked) |

### Modal Payload Example

```json
{
  "type": 9,
  "data": {
    "custom_id": "secret_note_modal",
    "title": "Secret Note",
    "components": [
      {
        "type": 18,
        "label": "Do you like me?",
        "component": {
          "type": 23,
          "custom_id": "like_checkbox"
        }
      }
    ]
  }
}
```

### Submit Interaction Data Example

```json
{
  "type": 5,
  "data": {
    "custom_id": "secret_note_modal",
    "components": [
      {
        "id": 1,
        "type": 18,
        "component": {
          "custom_id": "like_checkbox",
          "id": 2,
          "type": 23,
          "value": true
        }
      }
    ]
  }
}
```

---

## User Select

A User Select modal component allows picking a Discord user from the client/guild context. In modals, it is wrapped in a Label component (type 18).

### User Select Structure

| Field       | Type    | Description                                                          |
| ----------- | ------- | -------------------------------------------------------------------- |
| type        | integer | `5` for User Select                                                  |
| custom_id   | string  | Developer-defined identifier for the input; 1-100 characters         |
| min_values? | integer | Minimum number of users that must be selected (default: 1)           |
| max_values? | integer | Maximum number of users that can be selected (default: 1)             |
| required?   | boolean | Whether a selection is required before submitting (default: true)    |

### Modal Payload Example

```json
{
  "type": 9,
  "data": {
    "custom_id": "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
    "title": "Add Blacklist",
    "components": [
      {
        "type": 18,
        "label": "Member",
        "description": "Choose a member to exclude from personalization.",
        "component": {
          "type": 5,
          "custom_id": "userblacklist_add_user_nonce123",
          "min_values": 1,
          "max_values": 1,
          "required": true
        }
      }
    ]
  }
}
```

### Submit Interaction Data Example

```json
{
  "type": 5,
  "data": {
    "custom_id": "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
    "components": [
      {
        "id": 1,
        "type": 18,
        "component": {
          "custom_id": "userblacklist_add_user_nonce123",
          "id": 2,
          "type": 5,
          "values": ["123456789012345678"]
        }
      }
    ]
  }
}
```

---

## Moderation compound modals

TomoriBot's `/moderation` removal actions combine up to five Checkbox Groups with ten options each. Every entry
is initially checked. Unchecking an entry expresses removal on submit, without a second confirmation. The route
stores the presented values under the modal nonce and consumes that snapshot once, so it can distinguish an
unchecked entry from an entry added concurrently after the modal opened. Lists above 50 entries must use a
bounded fallback instead of silently truncating the modal.

The `/moderation` **Personas** add modal combines a String Select for the configured persona with a native Channel
Select restricted to text channels. The server persona limit is below Discord's 25-option String Select limit.

---

## Channel Select

A Channel Select modal component allows picking a Discord channel from the server context, with optional channel type filtering (e.g. `GuildText`). In modals, it is wrapped in a Label component (type 18).

### Channel Select Structure

| Field          | Type             | Description                                                           |
| -------------- | ---------------- | --------------------------------------------------------------------- |
| type           | integer          | `8` for Channel Select                                                |
| custom_id      | string           | Developer-defined identifier for the input; 1-100 characters          |
| channel_types? | array of integer | Allowed channel type integers (e.g. `[0]` for GuildText)              |
| min_values?    | integer          | Minimum number of channels that must be selected (default: 1)         |
| max_values?    | integer          | Maximum number of channels that can be selected (default: 1)           |
| required?      | boolean          | Whether a selection is required before submitting (default: true)     |

### Modal Payload Example

```json
{
  "type": 9,
  "data": {
    "custom_id": "moderation:v1:whitelist-channel-add-submit:en-US:nonce123",
    "title": "Add or Edit Channel",
    "components": [
      {
        "type": 18,
        "label": "Channel",
        "description": "Choose a text channel to whitelist.",
        "component": {
          "type": 8,
          "custom_id": "whitelist_channel_add_channel_nonce123",
          "channel_types": [0],
          "min_values": 1,
          "max_values": 1,
          "required": true
        }
      }
    ]
  }
}
```

### Submit Interaction Data Example

```json
{
  "type": 5,
  "data": {
    "custom_id": "moderation:v1:whitelist-channel-add-submit:en-US:nonce123",
    "components": [
      {
        "id": 1,
        "type": 18,
        "component": {
          "custom_id": "whitelist_channel_add_channel_nonce123",
          "id": 2,
          "type": 8,
          "values": ["123456789012345678"]
        }
      }
    ]
  }
}
```

---

## Role Select

A Role Select modal component picks one or more roles from the current server. It uses component type `6` and
is wrapped in a Label component (type `18`) in modal payloads. Routed Role Select values use the same
nonce-bounded, consume-once transport as User and Channel Select fields.

```json
{
  "type": 18,
  "label": "Role",
  "description": "Choose a role whose members can trigger me.",
  "component": {
    "type": 6,
    "custom_id": "whitelist_role_add_role_nonce123",
    "min_values": 1,
    "max_values": 1,
    "required": true
  }
}
```

Submission data carries the selected role snowflake in the nested component's `values` array. The handler must
resolve it again through the current guild role manager and reject the everyone role before writing.

---

## Component Selection Standards

Use this decision guide when choosing between modal input types.

### When to Use Each Component

| Component        | Use When                                                                                          | Avoid When                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Text Input**   | Free-form text entry: names, prompts, tags, API keys, URLs                                       | The input is a choice from a known set of options                                              |
| **String Select** | Large option sets (11+), dynamic/growing lists, options needing emoji or rich descriptions       | Small fixed set of mutually exclusive options (use Radio Group instead)                        |
| **Radio Group**  | Small fixed set of mutually exclusive options (2-10), unlikely to grow beyond 10                  | Option list is dynamic or may exceed 10 items (use String Select instead)                     |
| **Checkbox Group** | Multiple items can be selected from a list (1-10 options), OR a single required yes/no toggle  | Mutually exclusive choice (use Radio Group)                                                   |
| **Checkbox**     | Single **optional** yes/no or on/off toggle question                                             | The answer is **required** (use Checkbox Group with 1 option instead)                         |

### Boolean Input Pattern

Many TomoriBot modals include yes/no, enable/disable, or true/false string selects. These should be migrated to:

- **Optional boolean** → **Checkbox**: Unchecked submits as `false`, checked as `true`. The user can leave it unchecked and still submit.
- **Required boolean** → **Checkbox Group with 1 option**: Set `required: true` and provide a single option. This forces the user to explicitly check it before submitting — acting as a required confirmation or acknowledgment.

```json
// Required boolean workaround: Checkbox Group with 1 option
{
  "type": 18,
  "label": "Enable this server?",
  "component": {
    "type": 22,
    "custom_id": "enable_toggle",
    "required": true,
    "options": [
      {"value": "true", "label": "Yes, enable"}
    ]
  }
}
```

### Decision Flowchart

```
Is the input free-form text?
  └─ Yes → Text Input
  └─ No → Is it a single yes/no question?
            └─ Yes → Is the answer required?
                      └─ Yes → Checkbox Group (1 option, required: true)
                      └─ No  → Checkbox
            └─ No → Can the user select multiple options?
                      └─ Yes → Checkbox Group (if ≤10 options)
                      └─ No → Is the option set small and fixed (≤10)?
                                └─ Yes → Radio Group
                                └─ No → String Select (supports 25+ via pagination)
```

### Key Constraints

- **Radio Group**: 2-10 options. No emoji support. No placeholder text.
- **Checkbox Group**: 1-10 options. Supports `min_values`/`max_values` for range control. Also serves as the workaround for required single-boolean inputs.
- **Checkbox**: Cannot be `required`. Use a Checkbox Group with 1 option if required behavior is needed.
- **String Select**: Up to 25 options natively. Flows on the anchor message workflow must use `selection.openModal(...)` / `openAnchorModal(...)`, whose `>25` bridge keeps the range selector on the anchor Components V2 message. Flows still on `promptWithPaginatedModal()` may pass `selectorStyle: "componentsV2"` to render that same `>25` selector (`1-25`/`26-50` + Previous/Cancel/Next), or omit it for the legacy numbered page-button embed (default). Both selectors share `buildRangeSelectorPayload`. Supports emoji, descriptions, and placeholder text.
- **All new components** must be wrapped in a **Label** (type 18), not an Action Row.

### Anchor workflow modal bridge

Inside a anchor message workflow, do not call `promptWithPaginatedModal()` or
`promptWithRawModal()` directly — they would open the modal outside the anchor message
and strand its controls. Open the modal from the workflow instead. After a persona is
selected that means the selection phase from `runPersonaPickerWorkflow(...)`:

```ts
const modal = await selection.openModal(modalOptions);
```

Non-persona commands reach the same bridge through `openAnchorModal(...)`
(`src/utils/discord/ui/anchorModelFlow.ts`), which wraps the call below and renders the
error terminal for transport failures.

When `modalOptions` are already in memory and the select has at most 25 choices,
`openModal` calls `showModal()` as the selected button's first acknowledgment. Do not call
`beginInPlaceWork()` first; a deferred button cannot open a modal.

If building the options requires DB, filesystem, or network work, pass an asynchronous
factory instead:

```ts
const modal = await selection.openModal(async () => {
  const rows = await repository.loadOptions(selection.persona.persona_id);
  return buildModalOptions(rows);
});
```

The factory form immediately update-defers the persona button, replaces the picker with a
localized loading state, and only then runs the factory. Because that button is now consumed,
the workflow renders a fresh **Open Form** button for at most 25 choices or a range selector
for more than 25. The fresh button opens the modal as its first acknowledgment.

For larger sets, range buttons represent absolute slices of 25 (`1-25`, `26-50`, ...).
Range navigation, cancellation, and timeout replace the same anchor message. The chosen
range button opens the sliced modal, and a submitted phase reports `optionOffset`; add it to
page-local indexes when the option values themselves are not stable IDs.

The bridge slices **exactly one** select component and treats every entry as a selectable
option. A modal that breaks either assumption — several selects sharing one option list, or
a reserved entry such as an explicit "None" that must appear on every page — cannot use it.
Those pick a range up front with `acquireModalOptionRange(...)`, passing a `pageSize` below
25 to leave room for the reserved entries, and then open a modal whose list is already
sliced to 25 or fewer.

After submission, call `modal.phase.beginInPlaceWork()` before any slow validation or write.
It update-defers the message-backed modal submission and returns the anchor-message
controller. For an already-built terminal payload, `modal.phase.replace(payload)` instead
uses the unacknowledged message-backed submission's `update()` as the first acknowledgment.
Do not call both operations for one submission. If `openModal(...)` returns `fatal`, stop the callback (the normal pattern is
`throw modal.error`). The runner also records that fatal state, so even an accidental retry
directive cannot reopen the picker.

`PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS` controls how long the in-place launcher/range
buttons remain active (default 120000 ms). It does not alter Discord's modal lifetime.

### Bulk Configuration Management Pattern

When a modal is editing an existing list of configured items, prefer Checkbox Groups over a one-at-a-time String Select when the full set fits in a single modal.

- Pre-check every current entry and treat unchecked items as "remove" or "disable".
- Use `min_values: 0` and `required: false` so users can submit with every item unchecked.
- Chunk one category across multiple groups of 10 options, or split different entity types into separate groups.
- Give the first group a domain title such as **Whitelisted Personas** and a short instruction such as
  "Uncheck box then submit to remove whitelist." Name later groups **Continuation (1)**,
  **Continuation (2)**, and so on, without repeating the description.
- Respect Discord's modal ceiling: 5 checkbox groups, 10 options each, 50 total entries.
- If the list exceeds 50, keep the originating control panel visible and show a temporary yellow selection receipt
  above it with bounded range buttons such as `1-50` and `51-100`. A range button opens a modal containing only
  that snapshot. Repaint or remove the receipt after the bounded workflow ends; never silently truncate.
- For persistent setting commands, treat checked items as the stored enabled-set and write the full checked set back on submit.

Implemented examples:

- `/moderation` manages blacklist, channel, persona, and role removals through domain-specific checklist modals.
- `/config` > Channels > Channel Rules manages the full saved private-channel set in one modal, with paginated fallback beyond 50 channels.
- `/config` > Channels > Channel Rules manages the full saved RP-channel set in one modal, with paginated fallback beyond 50 channels.
- `/config` > Channels > Channel Rules manages a persistent channel blocklist with saved check states and paginated fallback beyond 50 channels.
- `/config` > Engine > Notices manages visible notice embed types in one modal.
- `/model override remove` remains a combined aggregate managing channel and persona overrides together, opening direct raw modal batches up to 50, and offering page selection above that.
- MCP registrations are deliberately excluded from this pattern: the `/config` > Plugins > MCP
  Servers page removes one registration at a time behind an explicit confirmation, so selection
  never becomes destructive consent.
- `/config` > Models > Fallbacks & Randomizer manages the fallback chain in one modal, and each slot can be cleared directly with the built-in `None` option.
- `/config` > Behavior > Trigger removes random triggers in one modal when the set fits; beyond 50 schedules, Remove first repaints the page into an explicit removal-range state whose selector opens each batch.
- `/config` > Behavior > Trigger adds a random trigger for any persona page: past 24 selectable personas the Add button becomes a range select that opens the modal on the chosen page, because the modal repeats its fixed Random entry on every page and that entry spends one of Discord's 25 option slots.
- `/server trigger remove` manages trigger words for the selected persona in one modal when the set fits, with paginated fallback beyond modal limits.

---

## TomoriBot Migration Audit

A full survey of all modals in the codebase, categorized by migration eligibility.

### Strong Candidates — Radio Group

These modals use a String Select with a small, fixed, mutually exclusive option set that is unlikely to grow beyond 10:

| Command                   | File                         | Custom ID              | Current Input | Options                                   | Why Radio Group                                     |
| ------------------------- | ---------------------------- | ---------------------- | ------------- | ----------------------------------------- | --------------------------------------------------- |
| `/config` > Engine > General       | `config/humanizer.ts`        | `humanizer_select`     | String Select | 4-5 (none/light/moderate/heavy; + inherit with `scope: Persona`) | Fixed set of mutually exclusive degrees             |
| `/setup`           | `setup.ts`            | `humanizer_degree`     | String Select | 4 (none/light/default/heavy)              | Same fixed humanizer degree set as above            |
| `/personal config`       | `utils/discord/ui/personalConfigPanel.ts` | `privacy_select`       | String Select | 3 (minimal/partial/full)                  | Fixed set of 3 mutually exclusive levels            |
| `/generate image`         | `generate/image.ts`          | `aspect_ratio_select`  | String Select | 10 (1:1, 2:3, 3:2, 3:4, 4:3, etc.)      | Fixed set of 10 aspect ratios — at the limit        |
| `/config` > Plugins > MCP Servers Add form | `discord/ui/mcpsPanel.ts` | `server-type_{nonce}` | Radio Group | 3 (General Purpose/Web Search/URL Fetcher) | Already migrated: required routed field with General Purpose selected by default |
| `/compact`           | `compact.ts`                 | `summary_type`         | String Select | 2 (conversation/roleplay)                 | Fixed binary mode selection                         |

### Strong Candidates — Checkbox / Checkbox Group (Boolean Selects)

These modals currently use a 2-option String Select (yes/no, true/false, enable/disable) that should become a Checkbox or Checkbox Group depending on whether the answer is required:

| Command                    | File                            | Custom ID              | Current Options          | Required | Migration Target                               |
| -------------------------- | ------------------------------- | ---------------------- | ------------------------ | -------- | ---------------------------------------------- |
| `/config` > Engine > Trigger| `config/randomtrigger/add.ts`  | `respond_to_self`      | Yes / No                 | Yes      | **Checkbox Group** (1 option, required)        |
| `/compact`            | `compact.ts`                   | `refresh_context`      | Yes / No                 | Yes      | **Checkbox Group** (1 option, required)        |
| `/compact`            | `compact.ts`                   | `analyze_images`       | Yes / No                 | Yes      | **Checkbox Group** (1 option, required)        |
| `/config provider switch`  | `config/provider/switch.ts`    | `save_current_select`  | Yes / No (default: Yes)  | No       | **Checkbox** (default: true, rarely unchecked) |
| `/respond`                 | `respond.ts`                   | `use_reasoning`        | Yes / No                 | No       | **Checkbox** (optional toggle)                 |
| `/persona export`          | `persona/export.ts`            | `export_json_select`   | False / True             | No       | **Checkbox** (optional toggle)                 |

> **Note on `/config provider switch`:** This modal has _two_ migration candidates — the save-current-config toggle becomes a **Checkbox** (default checked, since users almost always want to save). The provider select itself is dynamic (loaded from DB via `loadUniqueProviders()`), so it stays as a String Select.

> **Note on `/compact`:** This modal has _three_ migration candidates — `summary_type` becomes a Radio Group, while `refresh_context` and `analyze_images` both become required Checkbox Groups.

### Strong Candidates — Checkbox Group Bulk Management

These commands still remove one dynamic item at a time, but the data shape is a good fit for the unchecked-means-remove pattern:

| Command                    | File                               | Current Input         | Why Checkbox Groups Fit                                                   | Notes                                                                 |
| -------------------------- | ---------------------------------- | --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/config` > Persona > Identity & Personality | `persona/attribute/remove.ts`      | Persona picker + single paginated select | Personality attributes are usually reviewed and pruned in batches        | Needs index-safe array rewrite if duplicate attributes must be preserved |
| `/scheduled-task remove` | `scheduled-task/remove.ts`      | Persona picker + single paginated select | Reminder cleanup is often batch-oriented, especially for stale schedules | Manager-only reminder views may need concise descriptions              |
| `/config` > Persona > Identity & Personality | `persona/sample-dialogue/remove.ts` | Persona picker + single paginated select | Dialogue cleanup is often batch-oriented and already has index-safe removal | Good fit for index-valued checkbox groups                              |
| `/persona remove`          | `persona/remove.ts`                | Single paginated select | Alter persona cleanup could be batch-managed                             | Should pair the bulk UI with stronger destructive-action messaging     |

### Not Candidates — Keep String Select

These modals have dynamic or large option sets that exceed Radio Group/Checkbox Group limits:

| Command                          | File                             | Reason                                                    |
| -------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `/config provider switch`        | `config/provider/switch.ts`      | Provider list is dynamic (DB via `loadUniqueProviders()`) |
| `/config` > Models > Switch Models             | `config/model/text.ts`           | Dynamic model list, often 25+, uses pagination            |
| `/config` > Models > Switch Models            | `config/model/image.ts`          | Dynamic model list, uses pagination                       |
| `/config` > Models > Switch Models           | `config/model/vision.ts`         | Dynamic model list, uses pagination                       |
| `/config` > Models > Switch Models        | `config/model/embedding.ts`      | Dynamic model list, uses pagination                       |
| `/config` > Models > Fallbacks & Randomizer         | `config/model/fallback.ts`       | Dynamic model list, uses pagination                       |
| `/config` > Engine > General       | `config/system-prompt/preset.ts`     | Dynamic preset list from DB                               |
| `/config provider add`            | `config/provider/add.ts`          | Provider select + text input combo; list may grow         |
| `/config` > Persona > Advanced            | `persona/prompt/set.ts`         | Components V2 persona workflow first, then a prefilled free-form prompt modal (up to 16000 chars, 4 fields) |
| `/config` > Persona > Identity & Personality | `persona/attribute/add.ts`      | Dynamic persona list, uses pagination                     |
| `/config` > Persona > Identity & Personality | `persona/sample-dialogue/add.ts`| Dynamic persona list, uses pagination                     |
| `/config` > Persona > Appearance      | `persona/image-tags.ts`      | Components V2 persona workflow, then a prefilled free-form tag modal |
| `/config` > Persona > Identity & Personality | `persona/attribute/remove.ts`   | Dynamic attribute list, uses pagination                   |
| `/scheduled-task remove`      | `scheduled-task/remove.ts`   | Dynamic reminder list                                     |
| `/config` > Channels > Logs & Welcome    | `server/welcome-channel/set.ts`  | Channel option + dynamic persona list                     |

### Not Candidates — Keep Text Input

These modals collect free-form text and have no structured option set:

| Command                    | File                          | Reason                                                  |
| -------------------------- | ----------------------------- | ------------------------------------------------------- |
| `/config` > Engine > General | `config/system-prompt/set.ts`  | Free-form paragraph text (up to 16000 chars, 4 fields)  |
| `/config` > Engine > Trigger| `config/random-trigger/add.ts` | Free-form trigger word/phrase (text input portion stays) |
| `/config` > Persona > Advanced | `utils/discord/ui/configModals.ts` | 5 free-form text fields (author, title, tags, etc.) |
| `/personal config`         | `utils/discord/ui/personalConfigPanel.ts` | Free-form physical appearance image tag text            |
| `/config` > Models > Image Generation Defaults   | `config/image-tags/default-negative.ts`    | Free-form default negative tag text                     |
| `/config` > Models > Image Generation Defaults      | `config/image-tags/default-positive.ts`       | Free-form default positive tag text                  |
| `/persona create`          | `persona/create.ts`           | Free-form text fields + file upload                     |
| `/persona generate`        | `persona/generate.ts`         | Free-form name + file upload                            |
| `/server trigger add`      | `server/trigger/add.ts`       | Free-form text fields (word, response, cooldown)        |
| `/server avatar`           | `server/avatar.ts`            | Persona select + optional file upload                   |
| `/comment`                 | `comment.ts`                  | Free-form paragraph text                                |
| `/import personal memories` | `import/personal/memories.ts` | File upload only                                      |

### Provider Select To Model Modal

`/config` > Models > Switch Models and `/personal config` > Models > Switch Models share one shape,
built from `buildModelRoutingControl` and `buildProviderPageEntries` in
`src/utils/discord/ui/modelRoutingControls.ts`:

1. One String Select per capability, whose options are the eligible providers.
2. Choosing a provider whose catalog fits a modal page opens a modal holding the model select.
3. Choosing a provider whose catalog does not fit expands it in place into one option per page
   (`Google (page 2)`), and choosing a page opens the modal on that slice.

Two constraints force this shape rather than a second panel page. A modal select holds 25 options
and cannot page inside itself, and a prev/next row cannot open the page it is parked on, so the
range has to be chosen before the modal opens. Meanwhile a modal's components do not count against
the forty-component panel budget, so moving the catalog there is what lets six capability selectors
share one page.

The two surfaces differ only where the domain differs. A user inherits from the server, so the
leading option is `Using Server Default` on every capability; a server has nothing to inherit from,
so the leading option is a clear, present only on the slots whose absorbed command offered one
(`CONFIG_CLEARABLE_MODEL_CAPABILITIES`) and only while something is assigned.

Range navigation also differs by budget. `/personal config` renders a prev/next pagination row
beneath each selector. `/config` cannot: six selectors would spend eighteen components on
navigation alone, so its provider entries carry their own advance option
(`encodeConfigProviderRangeValue`) which wraps at the last window. Fallbacks keeps the pagination
row, because that page has one selector and the room for it.

### Split-Prompt Field Labelling

A Discord text input holds 4,000 characters, so a long prompt is stored whole and split across
several fields on open (`splitPromptIntoModalParts`) and rejoined on submit
(`combineModalPromptParts`). Every such field must be labelled through
`promptPartLabel`/`promptPartDescription` in `src/utils/discord/ui/modalPromptPartLabels.ts`, which
renders `Channel Prompt (Part 2 of 4)` plus a description naming the part it continues. Identical
labels on consecutive fields read as separate prompts and invite people to retype the whole thing
in each one.

The Channel Prompt, System Prompt, and Persona Prompt modals all use it. Two-field editors that
already carry an explicit `(Part 2)` label, such as attribute and sample-dialogue editing, are
unaffected.

### Button-To-Modal Confirmation Pattern

When a flow needs both a selection modal and a later prefilled edit modal, use:

1. selection modal
2. confirmation embed with buttons
3. `showModal()` from the confirm button interaction

This is the pattern used by the attribute and sample-dialogue edit flows on `/config` > Persona > Identity & Personality.

For persona-scoped flows that already have a persistent ephemeral picker message, prefer replacing that same message with the confirmation embed and later success state instead of spawning a second ephemeral thread.

Do **not** use `promptWithConfirmation()` for this case.
It eagerly `deferUpdate()`s the button click in its collector filter, which consumes the interaction and prevents the next `showModal()` call.

Use `promptWithUnacknowledgedConfirmation()` instead so the confirm button interaction stays available for the edit modal.

---

## discord.js Support Status

The current discord.js builder/data surface does not model every one of these inputs. TomoriBot sends
Label-wrapped raw modal payloads through Discord REST and intercepts the gateway submission before
discord.js parsing, preserving Radio Group, Checkbox Group, Checkbox, select, and file-upload values.
Most command-local flows use `promptWithRawModal()` and its bounded collector. The persistent MCP
Add form, reached from `/config` > Plugins > MCP Servers, reuses the raw send and value interception
without that collector: nonce-bounded `config:v2` modal submissions go through the global interaction
router, and interception is installed during startup so an already-open supported modal remains
routable after a process restart.
