import {z} from 'zod';

export const CaptionSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  timestampMs: z.number().nullable(),
  confidence: z.number().nullable(),
});

export const MediaClipSchema = z.object({
  id: z.string(),
  type: z.enum(['video', 'image']),
  src: z.string(),
  sourcePath: z.string(),
  from: z.number(),
  durationInFrames: z.number(),
  trimBefore: z.number(),
});

export const PrayerVideoSchema = z.object({
  fps: z.number(),
  durationInFrames: z.number(),
  audioDurationSeconds: z.number(),
  renderedDurationSeconds: z.number(),
  audioSrc: z.string(),
  captions: z.array(CaptionSchema),
  clips: z.array(MediaClipSchema),
  selectedVideos: z.array(z.string()),
  selectedImages: z.array(z.string()),
  seed: z.string(),
  previewSeconds: z.number().nullable(),
  introSeconds: z.number().default(0),
  introText: z.string().default(''),
  musicSrc: z.string().nullable().default(null),
  musicVolume: z.number().default(0),
  musicIntroVolume: z.number().default(0.2),
});

export type PrayerVideoProps = z.infer<typeof PrayerVideoSchema>;
export type MediaClip = z.infer<typeof MediaClipSchema>;
