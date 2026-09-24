import { Response } from 'express';
import { messages } from '../constants/messages';
import { logger } from './logger';

export const sendInternalError = (res: Response, error?: unknown, logMessage: string = messages.errors.internal): void => {
  if (error !== undefined) {
    logger.error(logMessage, error);
  }
  res.status(500).json({ success: false, error: messages.errors.internal });
};

export const sendBadRequest = (res: Response, error: string): void => {
  res.status(400).json({ success: false, error });
};
