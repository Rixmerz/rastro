# agent-browsing Specification

## ADDED Requirements

### Requirement: Reading page text
`rastro read` SHALL return the visible text of the page's `main` region, or of
the whole page when there is none; `--region` SHALL select a region by the same
names `view` uses, `--ref` a single element, and `--find` SHALL keep only the
lines containing the text with two lines of context. The text SHALL be masked
with the secret registry and capped (12 000 characters by default) with a note
when cut. The MCP server SHALL expose it as `rastro_read`.

#### Scenario: A mail body that view cannot show
- **WHEN** a page's main region holds a paragraph of plain text and no interactive element
- **THEN** `rastro read` returns that paragraph while `rastro view` does not list it

#### Scenario: A named region
- **WHEN** the agent runs `rastro read --region aside`
- **THEN** only the text of the complementary landmark is returned
