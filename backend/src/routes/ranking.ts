import { Router, Request, Response } from 'express';
import {
  getPointsRanking,
  getCreditRanking,
  getMyPointsRank,
  getMyCreditRank,
  getTrendData,
  getStatsOverview,
} from '../services/rankingService';
import { AuthRequest } from '../middleware/auth';
import { messages } from '../constants/messages';
import { sendBadRequest, sendInternalError } from '../utils/httpResponses';

const router = Router();

router.get('/points', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const result = await getPointsRanking(Math.min(limit, 100));
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting points ranking');
  }
});

router.get('/credit', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const result = await getCreditRanking(Math.min(limit, 100));
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting credit ranking');
  }
});

router.get('/my/points', async (req: AuthRequest, res: Response) => {
  try {
    const volunteerId = req.user?.id || req.query.volunteer_id as string;
    if (!volunteerId) {
      sendBadRequest(res, messages.validation.volunteerIdRequired);
      return;
    }
    const result = await getMyPointsRank(volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting my points rank');
  }
});

router.get('/my/credit', async (req: AuthRequest, res: Response) => {
  try {
    const volunteerId = req.user?.id || req.query.volunteer_id as string;
    if (!volunteerId) {
      sendBadRequest(res, messages.validation.volunteerIdRequired);
      return;
    }
    const result = await getMyCreditRank(volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting my credit rank');
  }
});

router.get('/trend', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.start_date as string;
    const endDate = req.query.end_date as string;

    if (!startDate || !endDate) {
      sendBadRequest(res, messages.validation.dateRangeRequired);
      return;
    }

    const result = await getTrendData(startDate, endDate);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting trend data');
  }
});

router.get('/stats/overview', async (req: Request, res: Response) => {
  try {
    const result = await getStatsOverview();
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting stats overview');
  }
});

export default router;
