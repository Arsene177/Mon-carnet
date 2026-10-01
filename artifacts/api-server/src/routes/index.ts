import { Router, type IRouter } from "express";
import healthRouter from "./health";
import medichainRouter from "./medichain";

const router: IRouter = Router();

router.use(healthRouter);
router.use(medichainRouter);

export default router;
