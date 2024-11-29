// 使用基础的 cookie 实现替代 cloudflare session
export const sessionStorage = {
  async getSession(cookieHeader: string | null) {
    if (!cookieHeader) return new Map();
    try {
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map(cookie => {
          const [key, value] = cookie.trim().split('=');
          return [key, decodeURIComponent(value)];
        })
      );
      return new Map(Object.entries(cookies));
    } catch {
      return new Map();
    }
  },

  async commitSession(session: Map<string, string>) {
    const entries = Array.from(session.entries());
    return entries
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('; ') + '; Path=/; HttpOnly; SameSite=Lax';
  }
};

// 获取session
export async function getSession(request: Request) {
  const cookie = request.headers.get("Cookie");
  return sessionStorage.getSession(cookie);
}

// 创建用户会话
export async function createUserSession(userId: string, redirectTo: string) {
  const session = new Map();
  session.set("userId", userId);
  
  const setCookie = await sessionStorage.commitSession(session);
  return {
    "Set-Cookie": setCookie
  };
}

export async function authenticateRequest(request: Request) {
  const session = await getSession(request);
  const userId = session.get("userId");
  
  if (!userId) {
    throw new Response("Unauthorized", { status: 401 });
  }
  
  return userId;
}

// 销毁用户会话
export async function destroySession() {
  return "userId=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}
