import { Router, type IRouter } from "express";
import healthRouter from "./health";
import paysnapRouter from "./paysnap";

const router: IRouter = Router();

router.use(healthRouter);
router.use(paysnapRouter);

export default router;
