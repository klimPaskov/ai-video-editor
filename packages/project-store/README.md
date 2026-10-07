# Project store

Projects and their editable drafts.

- `store.ts`: creates and opens projects from library sources, with an immutable baseline per project.
- `transactions.ts`: the draft transaction journal. Every edit, from the manual tools, Magic Edit or an assistant, is a hash-chained transaction with an exact inverse, so Undo and Redo work across all of them and drafts survive restarts.
