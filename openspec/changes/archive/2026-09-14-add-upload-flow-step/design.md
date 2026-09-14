# Design

## Why the path cannot simply be captured better

A page never sees the real path of a chosen file. `input.value` is
`C:\fakepath\<name>` on every browser and every platform, by design, so a page
cannot learn anything about the visitor's disk. Rastro's capture script runs
*in the page*, so it is on the wrong side of that boundary.

The path therefore has to come from the caller. That is what parameters are
for, and the course URL already works this way.

## Naming the parameter

Derived from the field, falling back to `archivo`, then `archivo2` and so on
when a flow attaches more than one file. Parameter names are already constrained
to JS identifiers (S8, CWE-94: they are emitted as bare identifiers into
generated Playwright code), so the derived name is sanitised through the same
rule rather than a new one.

No default. A default would have to be either the placeholder path, which is
useless, or a path from the recording machine, which is a lie on anyone else's.
The run fails naming the parameter instead, which is the honest outcome and
matches how a missing `secret:` entry already behaves.

## Where the sandbox check lives

`assertUploadAllowed` is a private method on `EngineCore`, reached today only
from `act`. The flow runner builds its own `perform`, so it needs the same
check; `FlowRunnerCore` gains it as a method rather than the runner
reimplementing the rule. One rule, one place — a second copy is how the symlink
case gets forgotten in one of them.

## Why the locator is not parameterised

Tempting, and wrong for this case. Which section of a course a file belongs to
is a judgment call that varies per upload, and a recorded selector freezes one
answer. The composition that works is: the agent looks at the page, decides, and
runs the mechanical part as a flow. A flow that silently attaches a file to the
wrong unit is worse than one that stops and asks.

If locator parameterisation is wanted later, the honest version is scoping
(`within: <bundle>`), not string interpolation into a selector.
