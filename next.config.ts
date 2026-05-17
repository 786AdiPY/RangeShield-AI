import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    env: {
        GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
        Model_key: process.env.Model_key,
    },
};

export default nextConfig;
