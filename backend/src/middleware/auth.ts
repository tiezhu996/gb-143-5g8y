import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { messages } from '../constants/messages';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: 'admin' | 'volunteer';
  };
}

export const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: messages.auth.missingToken,
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  if (token === env.adminToken) {
    req.user = {
      id: 'admin',
      role: 'admin',
    };
    next();
    return;
  }

  if (token.startsWith('volunteer_')) {
    const volunteerId = token.replace('volunteer_', '');
    if (volunteerId) {
      req.user = {
        id: volunteerId,
        role: 'volunteer',
      };
      next();
      return;
    }
  }

  res.status(401).json({
    success: false,
    error: messages.auth.invalidToken,
  });
};

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: messages.auth.adminRequired,
    });
    return;
  }
  next();
};

export const requireVolunteerOrAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: messages.auth.authenticationRequired,
    });
    return;
  }
  next();
};
