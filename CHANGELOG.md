# Changelog

## 0.1.0

First public release.

- Shows a pandera schema's columns in the hover of any `DataFrame[Schema]`,
  `LazyFrame[Schema]` or `GeoDataFrame[Schema]`-typed symbol.
- Includes inherited columns, `Field(...)` constraints, and a link to the schema definition.
- `panderaHover.exclude` setting for the fallback file scan.
