export interface DreamAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  interpretation: string;
  title: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface AudioData {
  audioData: Float32Array;
  sampleRate: number;
}

export enum AppStatus {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  TRANSCRIBING = 'TRANSCRIBING',
  ANALYZING = 'ANALYZING',
  GENERATING_IMAGE = 'GENERATING_IMAGE',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR'
}
