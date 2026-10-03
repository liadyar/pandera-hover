import pandera.pandas as pa
from pandera.typing import Series, DataFrame
from typing import List, Optional

class TestSchema(pa.DataFrameModel):
    check: Series[str]
    this: Optional[Series[str]]
    out: Series[str] # Check this comment out as well!