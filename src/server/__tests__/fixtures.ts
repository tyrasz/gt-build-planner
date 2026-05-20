import type { GameSnapshot } from "../../shared/schemas.js";

export function mockSnapshot(): GameSnapshot {
  return {
    fetchedAt: "2026-05-20T00:00:00.000Z",
    company: {
      id: 7,
      name: "Test Combine",
      cash: 5_000_000,
      value: 25_000_000,
      pr: 140,
      technologies: [{ id: 1, level: 3 }],
      bases: [{ id: 101, planetId: 501, warehouseId: 301, name: "Foundry" }]
    },
    bases: [
      {
        id: 101,
        planetId: 501,
        warehouseId: 301,
        name: "Foundry",
        exp: 1,
        buildingSlots: [
          { id: 1, status: 1, building: { id: 5001, type: 10, level: 2, cond: 0.9 } },
          { id: 2, status: 0, buildingType: 0, level: 0 }
        ],
        productionOrders: []
      }
    ],
    warehouses: [
      {
        id: 301,
        cap: 1000,
        mats: [
          { id: 1, am: 300 },
          { id: 41, am: 10 },
          { id: 3, am: 1000 },
          { id: 26, am: 60 },
          { id: 52, am: 12 }
        ]
      }
    ],
    exchangeOrders: [],
    cashHistory: [],
    contracts: [],
    basePlans: [],
    wishlists: [],
    market: {
      prices: [
        { matId: 1, matName: "Iron Ore", currentPrice: 1000, avgPrice: 1200 },
        { matId: 41, matName: "Flux", currentPrice: 2000, avgPrice: 2300 },
        { matId: 35, matName: "Steel", currentPrice: 12000, avgPrice: 10000 },
        { matId: 3, matName: "Concrete", currentPrice: 300, avgPrice: 350 },
        { matId: 26, matName: "Construction Kit", currentPrice: 90000, avgPrice: 88000 },
        { matId: 52, matName: "Construction Vehicle", currentPrice: 180000, avgPrice: 170000 }
      ],
      details: []
    },
    gameData: {
      materials: [
        { id: 1, name: "Iron Ore", weight: 1, cp: 1000 },
        { id: 35, name: "Steel", weight: 2.5, cp: 48000 },
        { id: 41, name: "Flux", weight: 0.4, cp: 1800 },
        { id: 3, name: "Concrete", weight: 0.35, cp: 300 },
        { id: 26, name: "Construction Kit", weight: 2, cp: 90000 },
        { id: 52, name: "Construction Vehicle", weight: 5, cp: 180000 }
      ],
      buildings: [
        { id: 10, name: "Smelter" },
        { id: 20, name: "Warehouse" }
      ],
      recipes: [
        {
          id: 900,
          producedIn: 10,
          reqTech: 0,
          timeMinutes: 120,
          inputs: [{ id: 1, am: 100 }, { id: 41, am: 10 }],
          output: { id: 35, am: 20 }
        }
      ],
      baseBuildingCost: [{ id: 3, am: 250 }, { id: 26, am: 30 }, { id: 52, am: 10 }]
    },
    rateLimits: [],
    warnings: []
  };
}
