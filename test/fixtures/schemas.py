"""Fixture schemas for the parser tests. Never imported or run."""
from typing import Optional

import pandas as pd
import pandera.pandas as pa
from pandera.typing import Series


class OrderSchema(pa.DataFrameModel):
    """One row per order."""

    id: Series[int]
    customerId: Series[int]
    # Nullable extension dtype, since some orders have no coupon.
    couponId: Optional[Series[pd.Int64Dtype]] = pa.Field(nullable=True)
    status: Series[str] = pa.Field(isin=["OPEN", "SHIPPED", "CANCELLED"])
    total: Series[float] = pa.Field(ge=0)

    class Config:
        coerce = True


class ShippedOrderSchema(OrderSchema):
    shippedAt: Series[pd.Timestamp]
