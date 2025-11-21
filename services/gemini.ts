import { GoogleGenAI, Type, Modality } from "@google/genai";
import { DreamAnalysis } from "../types";

// API Key kontrolü
const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error("API Key bulunamadı! Lütfen Vercel Environment Variables ayarlarını kontrol edin.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "DUMMY_KEY_FOR_BUILD" }); // Build sırasında hata vermemesi için dummy key, runtime'da gerçek key olmalı.

// 1. Transcribe Audio (Speech to Text)
// Model: gemini-2.5-flash
export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  if (!apiKey) throw new Error("API Anahtarı eksik. Lütfen Vercel ayarlarından API_KEY ekleyin.");

  // Convert Blob to Base64
  const base64Audio = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(audioBlob);
  });

  // Ensure mimeType is valid or default to audio/webm
  const mimeType = audioBlob.type || 'audio/webm';

  try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
        parts: [
            {
            inlineData: {
                mimeType: mimeType,
                data: base64Audio
            }
            },
            {
            text: "Lütfen bu ses dosyasını tam olarak metne dök. Sadece söylenenleri yaz, başka bir şey ekleme."
            }
        ]
        }
    });
    return response.text || "";
  } catch (error: any) {
    console.error("Transcribe Error:", error);
    throw new Error(`Ses işlenirken hata: ${error.message || error}`);
  }
};

// 2. Analyze Dream (Text Interpretation)
// Model: gemini-2.5-flash (Changed from pro to flash for better free tier limits)
export const analyzeDreamText = async (dreamText: string): Promise<DreamAnalysis> => {
  if (!apiKey) throw new Error("API Anahtarı eksik. Lütfen Vercel ayarlarından API_KEY ekleyin.");

  try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Aşağıdaki rüyayı detaylı bir şekilde tabir et. 
        Rüya: "${dreamText}"
        
        Yanıtı kesinlikle şu JSON formatında ver:
        {
        "sentiment": "positive" veya "negative" (rüyayı genel havasına göre sınıflandır),
        "title": "Rüyaya kısa, mistik bir başlık",
        "interpretation": "Rüyanın detaylı, edebi ve mistik yorumu."
        }`,
        config: {
        responseMimeType: "application/json",
        responseSchema: {
            type: Type.OBJECT,
            properties: {
            sentiment: { type: Type.STRING, enum: ["positive", "negative", "neutral"] },
            title: { type: Type.STRING },
            interpretation: { type: Type.STRING }
            }
        }
        }
    });

    const jsonText = response.text;
    if (!jsonText) throw new Error("Analiz sonucu boş döndü.");
    return JSON.parse(jsonText) as DreamAnalysis;
  } catch (error: any) {
    console.error("Analysis Error:", error);
    throw new Error(`Rüya tabir edilirken hata: ${error.message || error}`);
  }
};

// 3. Generate Image
// Model: gemini-2.5-flash-image (Reliable free tier model)
export const generateDreamImage = async (dreamText: string, sentiment: string): Promise<string> => {
  if (!apiKey) return ""; // Görsel için sessizce başarısız ol, akışı bozma

  const moodPrompt = sentiment === 'positive' 
    ? "bright, ethereal, divine, heavenly light, soft pastel colors, dreamlike, masterpiece, 8k" 
    : "mysterious, dark moody, fog, gothic, deep shadows, intense, dreamlike, masterpiece, 8k";

  const prompt = `A surrealist oil painting interpretation of this dream: ${dreamText}. Style: ${moodPrompt}`;

  const extractImage = (response: any) => {
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    return null;
  };

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }]
      }
    });
    const img = extractImage(response);
    if (img) return img;
  } catch (e) {
    console.error("Image generation failed", e);
  }
  
  throw new Error("Görsel oluşturulamadı.");
};

// 4. Text to Speech
// Model: gemini-2.5-flash-preview-tts
// Returns raw float32 audio data and sample rate
export const generateDreamSpeech = async (text: string): Promise<{ audioData: Float32Array, sampleRate: number }> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' }, // Mystical female voice
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("Ses verisi alınamadı.");

  // Decoding Raw PCM Data (24kHz, Mono, 16-bit Integer)
  const binaryString = atob(base64Audio);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Handle potential odd byte length by flooring (Int16Array requires even byte length)
  const buffer = bytes.buffer;
  const pcm16 = new Int16Array(buffer, 0, Math.floor(bytes.length / 2));
  const float32 = new Float32Array(pcm16.length);
  
  // Convert Int16 to Float32
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768.0;
  }

  return {
    audioData: float32,
    sampleRate: 24000
  };
};

// 5. Keyword Chat
// Model: gemini-2.5-flash
export const askKeywordQuestion = async (
  dreamText: string, 
  interpretation: string, 
  question: string,
  history: {role: string, parts: {text: string}[]}[]
): Promise<string> => {
  
  const systemInstruction = `Sen Süpürge Otu adında bilge bir rüya tabircisisin. 
  Kullanıcı sana gördüğü rüya ile ilgili belirli sembolleri veya anahtar kelimeleri soracak.
  
  Görülen Rüya: "${dreamText}"
  Senin Yaptığın Tabir: "${interpretation}"
  
  Sadece sorulan anahtar kelimenin rüya tabirindeki anlamını açıkla. Kısa ve öz ol. Mistik bir dil kullan.`;

  const chat = ai.chats.create({
    model: 'gemini-2.5-flash',
    config: { systemInstruction },
    history: history
  });

  const result = await chat.sendMessage({ message: question });
  return result.text || "Sessizlik...";
};
