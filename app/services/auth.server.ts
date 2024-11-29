import { json } from '@remix-run/cloudflare';
import { getSession } from './session.server';

export type User = {
  id: string;
  email: string;
  name: string;
  avatar?: string;
};

export async function validateUser(email: string, password: string) {
  return { id: '1', email, name: 'Test User' };
}

export async function getUser(request: Request) {
  const session = await getSession(request);
  const userId = session.get('userId');

  console.log('==userId=', userId);

  if (!userId) {
    return null;
  }

  /*
   * 这里可以根据 userId 从数据库获取用户信息
   * 现在先返回一个模拟的用户数据
   */
  return {
    id: userId,
    email: 'test@example.com',
    name: 'Test User',
    avatar: '',
  };
}

export async function requireUser(request: Request) {
  const session = await getSession(request);
  const userId = session.get('userId');

  if (!userId) {
    throw json({ message: 'Unauthorized' }, { status: 401 });
  }

  return userId;
}
