# Changelog

## Unreleased

- Follows column changes made after a variable gets its schema (`drop`, `del`, column
  assignment, `rename`, `assign`, column selection, Polars `select`/`with_columns`, ...) and
  shows them in the hover as a diff against the schema. Changes that can't be read from
  literals are listed as notes.
- Follows a variable made from another one (`names = companies[["companyName", "issuerId"]]`)
  back to the other variable's schema. After a column selection, only the selected columns are
  shown, in selection order.

## 0.1.0

First public release.

- Shows a pandera schema's columns in the hover of any `DataFrame[Schema]`,
  `LazyFrame[Schema]` or `GeoDataFrame[Schema]`-typed symbol.
- Includes inherited columns, `Field(...)` constraints, and a link to the schema definition.
- `panderaHover.exclude` setting for the fallback file scan.
