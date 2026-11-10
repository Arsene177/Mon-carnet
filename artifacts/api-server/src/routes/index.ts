import { Router, type IRouter } from "express";
import healthRouter from "./health";
import medichainRouter from "./medichain";
import accountRouter from "./account";
import mfaRouter from "./mfa";

const router: IRouter = Router();

router.use(healthRouter);
router.use(medichainRouter);
router.use(accountRouter);
router.use(mfaRouter);

export default router;
