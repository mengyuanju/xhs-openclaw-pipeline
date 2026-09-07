export const DELIVERY_IMAGE_WIDTH = 1086;
export const DELIVERY_IMAGE_HEIGHT = 1448;

// GPT Image 2 requires both edges to be multiples of 16. Generate at the
// delivery aspect ratio so normalization only needs to scale the full canvas.
export const GENERATION_IMAGE_WIDTH = 1152;
export const GENERATION_IMAGE_HEIGHT = 1536;
export const GENERATION_IMAGE_SIZE = `${GENERATION_IMAGE_WIDTH}x${GENERATION_IMAGE_HEIGHT}`;
