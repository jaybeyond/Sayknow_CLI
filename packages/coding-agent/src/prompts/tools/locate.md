Find where behaviour lives by describing what the code does, when you do not know a file, symbol, or string to grep for.

<instruction>
- Ask a question about behaviour: "Where does the broker stop when idle?", "Which code picks fallback models?", "Which tests cover retry after a timeout?"
- Returns ranked files with their declaration lines and line numbers. Read the listed lines next; the result is a lead, not proof, and it can miss files.
- Use `search` or `find` instead when you already know an exact name, path, or string. They are faster and free.
- Narrow `path` to the part of the repository you care about when you can.
</instruction>

<data>
Relevance is judged by Jev (TypeSafe). It receives the question, folder paths, file names, and each candidate file's declaration lines (function, class, type, and constant signatures). It never receives function bodies or comments. Files ignored by .gitignore, hidden files, and binaries are skipped.
</data>
