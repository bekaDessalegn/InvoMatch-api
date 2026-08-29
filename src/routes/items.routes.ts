import { Router } from "express";

import {
  createItem,
  deleteItem,
  getItem,
  getItemPriceHistory,
  listItems,
  updateItem,
} from "../controllers/items.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { authenticate, requireStore } from "../middleware/auth";

export const itemsRouter = Router();

itemsRouter.use(asyncHandler(authenticate), asyncHandler(requireStore));

itemsRouter.get("/", asyncHandler(listItems));
itemsRouter.get("/:id", asyncHandler(getItem));
itemsRouter.get("/:id/price-history", asyncHandler(getItemPriceHistory));
itemsRouter.post("/", asyncHandler(createItem));
itemsRouter.patch("/:id", asyncHandler(updateItem));
itemsRouter.delete("/:id", asyncHandler(deleteItem));
