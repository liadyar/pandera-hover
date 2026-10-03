# Pandera Schema Hover

**See a pandera schema's columns right where you use the DataFrame. No jumping to the definition.**

With [pandera](https://pandera.readthedocs.io/), a hover over a typed DataFrame only tells you the
schema's *name*:

```text
(variable) orders: DataFrame[OrderSchema]
```

To know which columns `orders` actually has, you have to go find `OrderSchema`. This extension
adds the columns to the same hover:

![Hover showing OrderSchema's columns](images/hover.png)

```text
OrderSchema — models/orders.py:9
id        : Series[int]
customerId: Series[int]
couponId  : Optional[Series[pd.Int64Dtype]]  # nullable=True
status    : Series[str]  # isin=["OPEN", "SHIPPED", "CANCELLED"]
total     : Series[float]  # ge=0
```

## Features

- **Works anywhere the type shows up:** variables, function parameters, return values,
  attributes. If the hover says `DataFrame[Schema]`, you get the columns.
- **Always current:** columns are read from the schema's source on every hover, including
  unsaved edits. There's no copy that can drift.
- **Inheritance:** a schema that subclasses another one shows the inherited columns too.
- **`Field(...)` constraints** like `nullable=True`, `ge=0` and `isin=[...]` are shown next to
  each column.
- **Jump to the schema:** the schema name in the hover links to its definition.
- **pandas, Polars and GeoPandas:** `DataFrame[...]`, `LazyFrame[...]` and
  `GeoDataFrame[...]` from `pandera.typing` are all recognised.
- **Read-only and safe:** it never runs your code or imports Python. It only reads source text,
  so it also works in untrusted workspaces.

## Requirements

A Python language server that shows types on hover. **Pylance** (the default with the
Microsoft Python extension) and **basedpyright** both work. The extension adds to their hover
and doesn't replace it.

Your variables need a pandera type the language server can see, e.g.
`def load() -> DataFrame[OrderSchema]` or `orders: DataFrame[OrderSchema] = ...`. A plain
`pd.DataFrame` has no schema to show.

## Settings

| Setting | Default | Description |
|---|---|---|
| `panderaHover.exclude` | `venv`, `.venv`, `node_modules`, `site-packages`, `__pycache__` | Globs skipped when a schema has to be found by scanning `.py` files. Scanning is only a fallback, used when the language server's workspace symbols don't find the class. Add large data or vendored folders here. |

## Known limitations

- If two schema classes share a name, the one in the current file wins, then any in your
  workspace. Otherwise the first one found is shown.
- Columns are read from the class body as written. Columns added dynamically at runtime aren't
  shown.

## Contributing

Issues and PRs are welcome at
[github.com/liadyar/pandera-hover](https://github.com/liadyar/pandera-hover).

```bash
npm test          # parser tests: plain node, no VS Code needed
npm run package   # builds pandera-hover-<version>.vsix
```

To try a local build: `code --install-extension pandera-hover-<version>.vsix --force`, then
**Developer: Reload Window**.

## License

[MIT](LICENSE)
