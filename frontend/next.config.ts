import type { NextConfig } from "next";

const backendApiUrl = (process.env.BACKEND_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  agentRules: false,
  async rewrites() {
    return [
      {
        source: '/code/:path*',
        destination: `${backendApiUrl}/code/:path*`,
      },
      {
        source: '/api/sessions',
        destination: `${backendApiUrl}/api/sessions`,
      },
      {
        source: '/api/sessions/:path*',
        destination: `${backendApiUrl}/api/sessions/:path*`,
      },
      // 工作流 API
      {
        source: '/api/project/:path*',
        destination: `${backendApiUrl}/api/project/:path*`,
      },
      {
        source: '/api/stages',
        destination: `${backendApiUrl}/api/stages`,
      },
      {
        source: '/api/upload_media',
        destination: `${backendApiUrl}/api/upload_media`,
      },
      {
        source: '/api/upload_file',
        destination: `${backendApiUrl}/api/upload_file`,
      },
      {
        source: '/api/models',
        destination: `${backendApiUrl}/api/models`,
      },
      {
        source: '/api/config',
        destination: `${backendApiUrl}/api/config`,
      },
      {
        source: '/api/cache/:path*',
        destination: `${backendApiUrl}/api/cache/:path*`,
      },
      // 一键 pipeline API
      {
        source: '/api/pipelines',
        destination: `${backendApiUrl}/api/pipelines`,
      },
      {
        source: '/api/pipelines/:path*',
        destination: `${backendApiUrl}/api/pipelines/:path*`,
      },
      {
        source: '/api/tasks',
        destination: `${backendApiUrl}/api/tasks`,
      },
      {
        source: '/api/tasks/:path*',
        destination: `${backendApiUrl}/api/tasks/:path*`,
      },
      // 临时工作台 API
      {
        source: '/api/sandbox/:path*',
        destination: `${backendApiUrl}/api/sandbox/:path*`,
      },
    ];
  },
};

export default nextConfig;
