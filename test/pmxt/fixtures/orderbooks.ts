import {
  PmxtPriceLevel,
  PmxtSdkOrderBook,
} from "../../../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";

export const fullYesBook: PmxtSdkOrderBook = {
  asks: [
    { price: 0.52, size: 10 },
    { price: 0.55, size: 5 },
  ],
};

export const fullNoBook: PmxtSdkOrderBook = {
  asks: [{ price: 0.48, size: 5 }],
};

export const emptyYesBook: PmxtSdkOrderBook = { asks: [] };
export const emptyNoBook: PmxtSdkOrderBook = { asks: [] };

export const oneSidedYesBook: PmxtSdkOrderBook = { asks: [{ price: 0.52, size: 10 }] };
export const oneSidedNoBook: PmxtSdkOrderBook = { asks: [] };

export const sortedYesBook: PmxtSdkOrderBook = {
  asks: [
    { price: 0.6, size: 1 },
    { price: 0.5, size: 2 },
  ],
};

export const unknownFieldYesBook: PmxtSdkOrderBook = {
  asks: [{ price: 0.5, size: 1 }],
  surprise: "field",
};

export const badPriceBook: PmxtSdkOrderBook = { asks: [{ price: 1.2, size: 1 }] };
export const zeroSizeBook: PmxtSdkOrderBook = { asks: [{ price: 0.5, size: 0 }] };
export const malformedLevelBook: PmxtSdkOrderBook = { asks: [{ price: "bad", size: 1 } as unknown as PmxtPriceLevel] };
