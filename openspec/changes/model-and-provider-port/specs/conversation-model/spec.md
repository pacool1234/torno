## Purpose

How torno represents a conversation internally — messages, roles and content blocks — independently of any model provider's format, so that the agent and every provider adapter share one model.

## ADDED Requirements

### Requirement: Messages have a role and ordered content

A message SHALL have exactly one role, either `user` or `assistant`, and an ordered list of one or more content blocks. The order of blocks SHALL be preserved exactly as given. System instructions SHALL NOT be represented as a message; they belong to the provider request.

#### Scenario: Block order is preserved

- **WHEN** an assistant message is created with a text block followed by a tool call block
- **THEN** reading its content returns the text block first and the tool call block second

#### Scenario: A message without content is rejected

- **WHEN** a message is created with an empty list of content blocks
- **THEN** the type checker rejects it

### Requirement: Text blocks

A text block SHALL carry a string of text.

#### Scenario: Text is kept unchanged

- **WHEN** a text block is created with the text "Hello\n world"
- **THEN** its text is exactly "Hello\n world", including line breaks and spaces

### Requirement: Tool call blocks

A tool call block SHALL carry an id, the name of the tool to run, and its input as a parsed object (never as an unparsed JSON string). Tool call blocks SHALL only appear in assistant messages.

#### Scenario: Tool call carries a parsed input

- **WHEN** an assistant message contains a tool call with id "call_1", name "read_file" and input `{ "path": "a.ts" }`
- **THEN** the input can be read as an object whose `path` property is "a.ts", without any JSON parsing

#### Scenario: Tool calls are only valid in assistant messages

- **WHEN** a user message is created containing a tool call block
- **THEN** the type checker rejects it

### Requirement: Tool result blocks

A tool result block SHALL carry the id of the tool call it answers, the result content as text, and whether the tool failed. Tool result blocks SHALL only appear in user messages.

#### Scenario: A failed tool result is marked as an error

- **WHEN** a tool result is created for call "call_1" with the content "File not found" and marked as failed
- **THEN** it refers to "call_1", its content is "File not found", and it is identifiable as an error

#### Scenario: Tool results are only valid in user messages

- **WHEN** an assistant message is created containing a tool result block
- **THEN** the type checker rejects it
