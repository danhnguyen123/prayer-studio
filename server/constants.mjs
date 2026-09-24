import path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const LANGUAGE_DEFINITIONS = {
  france: {
    label: 'France',
    targetName: 'French',
    translationKey: 'france',
    folder: 'france_korea',
    config: 'configs/france_prayer_deepseek.yaml',
    configs: {
      deepseek: 'configs/france_prayer_deepseek.yaml',
      gpt: 'configs/france_prayer_gpt_terra.yaml',
    },
  },
  poland: {
    label: 'Poland',
    targetName: 'Polish',
    translationKey: 'poland',
    folder: 'poland_korea',
    config: 'configs/poland_prayer_deepseek.yaml',
    configs: {
      deepseek: 'configs/poland_prayer_deepseek.yaml',
      gpt: 'configs/poland_prayer_gpt_terra.yaml',
    },
  },
  germany: {
    label: 'Germany',
    targetName: 'German',
    translationKey: 'germany',
    folder: 'germany_korea',
    config: 'configs/germany_prayer_deepseek.yaml',
    configs: {
      deepseek: 'configs/germany_prayer_deepseek.yaml',
      gpt: 'configs/germany_prayer_gpt_terra.yaml',
    },
  },
  italia: {
    label: 'Italy',
    targetName: 'Italian',
    translationKey: 'italia',
    folder: 'italia_korea',
    config: 'configs/italia_prayer_deepseek.yaml',
    configs: {
      deepseek: 'configs/italia_prayer_deepseek.yaml',
      gpt: 'configs/italia_prayer_gpt_terra.yaml',
    },
  },
  korea: {
    label: 'Korea',
    targetName: 'Korean',
    translationKey: 'korea',
    folder: 'korea_source',
    config: 'configs/korea_prayer_deepseek.yaml',
    configs: {
      deepseek: 'configs/korea_prayer_deepseek.yaml',
      gpt: 'configs/korea_prayer_gpt_terra.yaml',
    },
  },
};

export const DEFAULT_PATHS = {
  videoDir: process.env.DEFAULT_VIDEO_DIR || 'D:\\Materials\\Video 4K',
  imageDir: process.env.DEFAULT_IMAGE_DIR || 'D:\\Materials\\Pray\\Image',
  audioPath:
    'D:\\Project\\Italia Prayer\\5\\Script_1_2026_06_21_19_16_22.mp3',
  srtPath:
    'D:\\Project\\Italia Prayer\\5\\Script_1_2026_06_21_19_16_22.srt',
  musicPath: process.env.DEFAULT_MUSIC_PATH || path.join(PROJECT_ROOT, 'intro.MP3'),
  introSeconds: Number(process.env.DEFAULT_INTRO_SECONDS || 8),
  introText: '',
  musicVolume: Number(process.env.MUSIC_DUCK_VOLUME || 0), // 0 = tắt nhạc khi voiceover phát

  musicIntroVolume: Number(process.env.MUSIC_INTRO_VOLUME || 0.2),
};

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
