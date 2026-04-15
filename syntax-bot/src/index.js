/**
 * Geniok AI - Telegram Bot
 * AI Super App: ChatGPT, Claude, Gemini, Image/Video Generation
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '/root/CoWork-OS/syntax-bot/.env' });
import { Bot, InputFile } from "grammy";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import https from "https";
import http from "http";

// Configuration
const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-4o",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-3-5-sonnet-20241022",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: "gemini-2.0-flash",
  },
  music: {
    // Mubert API (free tier available at https://mubert.com)
    mubertToken: process.env.MUBERT_TOKEN || "",
  },
};

// Initialize AI clients
const openai = config.openai.apiKey 
  ? new OpenAI({ apiKey: config.openai.apiKey })
  : null;

const anthropic = config.anthropic.apiKey
  ? new Anthropic({ apiKey: config.anthropic.apiKey })
  : null;

const gemini = config.gemini.apiKey
  ? new GoogleGenerativeAI(config.gemini.apiKey)
  : null;

// Initialize Telegram Bot
const bot = new Bot(config.telegram.token);

// User session storage (in production, use Redis/DB)
const userSessions = new Map();

// Command: /start
bot.command("start", async (ctx) => {
  const welcome = `
🤖 <b>Geniok AI</b>

ваш AI супер ассистент
  `;
  
  await ctx.reply(welcome, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 Чат", callback_data: "chat" },
          { text: "🎨 Изображения", callback_data: "image_gen" }
        ],
        [
          { text: "🎵 Музыка", callback_data: "music_gen" },
          { text: "🎬 Видео", callback_data: "video_gen" }
        ],
        [
          { text: "🎙️ Голос", callback_data: "voice" },
          { text: "📚 Документы", callback_data: "documents" }
        ],
        [
          { text: "📖 Помощь", callback_data: "help" },
          { text: "⚙️ Профиль", callback_data: "profile" }
        ]
      ]
    }
  });
});

// Command: /help
bot.command("help", async (ctx) => {
  const help = `
<b>📖 Справка по Geniok AI</b>

<b>AI Модели:</b>
• GPT-4o - Универсальный, быстрый
• Claude 3.5 - Лучший для кода и анализа
• Gemini 2.0 - Google's AI

<b>Генерация музыки:</b>
/music &lt;описание&gt; - создать музыку
Пример: /music relaxing piano ambient

<b>Как использовать:</b>
Просто напишите вопрос боту!
  `;
  
  await ctx.reply(help, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" },
          { text: "🎵 Музыка", callback_data: "music_gen" }
        ],
        [
          { text: "🔄 Сменить модель", callback_data: "settings" }
        ]
      ]
    }
  });
});

// Command: /music (generate music)
bot.command("music", async (ctx) => {
  const args = ctx.message.text.replace("/music", "").trim();
  
  if (!args) {
    await ctx.reply(`
🎵 <b>Генерация музыки</b>

Использование: /music &lt;описание&gt;

<b>Примеры:</b>
/music relaxing ambient piano
/music energetic electronic dance
/music calm lofi hip hop
/music dramatic orchestral

<b>Стили:</b>
• ambient, electronic, rock, jazz, classical
• lofi, hiphop, pop, folk, metal
  `, { parse_mode: "HTML" });
    return;
  }
  
  await ctx.replyWithChatAction("upload_document");
  
  try {
    await ctx.reply(`🎵 <b>Генерация музыки...</b>

Запрос: ${args}
⏳ Подождите 10-30 секунд...`, { parse_mode: "HTML" });
    
    const musicUrl = await generateMusic(args, ctx);
    
    if (musicUrl) {
      await ctx.replyWithAudio(musicUrl, {
        caption: `🎵 <b>Ваша музыка!</b>

📝 Запрос: ${args}

Используйте /music &lt;описание&gt; для новой генерации`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎵 Ещё музыку", callback_data: "music_gen" }]
          ]
        }
      });
    } else {
      await ctx.reply(`
❌ <b>Генерация временно недоступна</b>

Попробуйте позже или опишите музыку иначе.

🎵 <b>Поддерживаемые стили:</b>
am • ambient • electronic • rock • jazz • classical
lofi • hiphop • pop • folk • metal • piano • orchestral
      `, { 
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Попробовать снова", callback_data: "music_gen" }]
          ]
        }
      });
    }
  } catch (error) {
    console.error("Music generation error:", error);
    await ctx.reply("❌ Ошибка при генерации музыки. Попробуйте позже.");
  }
});

// Command: /settings
bot.command("settings", async (ctx) => {
  const model = userSessions.get(ctx.from.id)?.model || "GPT-4o";
  
  const settings = `
<b>⚙️ Настройки</b>

<b>Текущая модель:</b> ${model}

<b>Выберите модель:</b>
  `;
  
  await ctx.reply(settings, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude 3.5", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini 2.0", callback_data: "model_gemini" }
        ],
        [
          { text: "🔙 Назад", callback_data: "back_to_start" }
        ]
      ]
    }
  });
});

// Command: /model
bot.command("model", async (ctx) => {
  const model = userSessions.get(ctx.from.id)?.model || "GPT-4o";
  
  const modelSelect = `
<b>🤖 Выбор AI модели</b>

<b>Текущая:</b> ${model}
  `;
  
  await ctx.reply(modelSelect, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude 3.5", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini 2.0", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Command: /chat (switch to GPT)
bot.command("chat", async (ctx) => {
  const session = userSessions.get(ctx.from.id) || {};
  session.model = "GPT-4o";
  userSessions.set(ctx.from.id, session);
  await ctx.reply("✅ <b>Модель:</b> GPT-4o", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Command: /claude (switch to Claude)
bot.command("claude", async (ctx) => {
  if (!anthropic) {
    await ctx.reply("❌ Claude не настроен. Добавьте ANTHROPIC_API_KEY");
    return;
  }
  
  const session = userSessions.get(ctx.from.id) || {};
  session.model = "Claude";
  userSessions.set(ctx.from.id, session);
  await ctx.reply("✅ <b>Модель:</b> Claude 3.5 Sonnet", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Command: /gemini (switch to Gemini)
bot.command("gemini", async (ctx) => {
  if (!gemini) {
    await ctx.reply("❌ Gemini не настроен. Добавьте GEMINI_API_KEY");
    return;
  }
  
  const session = userSessions.get(ctx.from.id) || {};
  session.model = "Gemini";
  userSessions.set(ctx.from.id, session);
  await ctx.reply("✅ <b>Модель:</b> Gemini 2.0 Flash", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 GPT-4o", callback_data: "model_gpt" },
          { text: "🧠 Claude", callback_data: "model_claude" }
        ],
        [
          { text: "✨ Gemini", callback_data: "model_gemini" }
        ]
      ]
    }
  });
});

// Handle all text messages
bot.on("message", async (ctx) => {
  // Ignore commands (they're handled above)
  if (ctx.message.text.startsWith("/")) {
    return;
  }
  
  const userId = ctx.from.id;
  const message = ctx.message.text;
  const session = userSessions.get(userId) || { model: "GPT-4o" };
  
  // Send "typing" indicator
  await ctx.replyWithChatAction("typing");
  
  try {
    let response;
    
    switch (session.model) {
      case "Claude":
        response = await chatWithClaude(message, ctx);
        break;
      case "Gemini":
        response = await chatWithGemini(message, ctx);
        break;
      default:
        response = await chatWithGPT(message, ctx);
    }
    
    // Reply with inline buttons
    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💬 GPT-4o", callback_data: "model_gpt" },
            { text: "🧠 Claude", callback_data: "model_claude" },
            { text: "✨ Gemini", callback_data: "model_gemini" }
          ],
          [
            { text: "🔄 Новая модель", callback_data: "settings" },
            { text: "📖 Помощь", callback_data: "help" }
          ]
        ]
      }
    });
    
  } catch (error) {
    console.error("AI Error:", error);
    await ctx.reply("❌ Произошла ошибка. Попробуйте позже.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Попробовать снова", callback_data: "retry" }]
        ]
      }
    });
  }
});

// Handle callback queries (inline button presses)
bot.on("callback_query", async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const session = userSessions.get(ctx.from.id) || { model: "GPT-4o" };
  
  switch (callbackData) {
    case "model_gpt":
      session.model = "GPT-4o";
      userSessions.set(ctx.from.id, session);
      await ctx.answerCallbackQuery("✅ GPT-4o выбран!");
      await ctx.editMessageText(`✅ <b>Модель изменена!</b>

💬 <b>GPT-4o</b> выбрана как активная модель.

Напишите сообщение для начала чата!`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 Чат с GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini", callback_data: "model_gemini" },
              { text: "⚙️ Настройки", callback_data: "settings" }
            ],
            [
              { text: "🔙 Главное меню", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "model_claude":
      if (!anthropic) {
        await ctx.answerCallbackQuery("❌ Claude не настроен", { show_alert: true });
        await ctx.editMessageText(`❌ <b>Claude не настроен!</b>

Для использования Claude добавьте API ключ.

📝 <b>Как получить:</b>
1. Зайдите на https://anthropic.com
2. Создайте аккаунт и получите API ключ
3. Добавьте в .env: ANTHROPIC_API_KEY=ваш_ключ

⚠️ Пока используйте <b>GPT-4o</b> (требуется OPENAI_API_KEY)`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 Использовать GPT-4o", callback_data: "model_gpt" }],
              [{ text: "🔙 Главное меню", callback_data: "back_to_start" }]
            ]
          }
        });
        return;
      }
      session.model = "Claude";
      userSessions.set(ctx.from.id, session);
      await ctx.answerCallbackQuery("✅ Claude 3.5 выбран!");
      await ctx.editMessageText(`✅ <b>Модель изменена!</b>

🧠 <b>Claude 3.5</b> выбран как активная модель.

Напишите сообщение для начала чата!`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Чат с Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini", callback_data: "model_gemini" },
              { text: "⚙️ Настройки", callback_data: "settings" }
            ],
            [
              { text: "🔙 Главное меню", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "model_gemini":
      if (!gemini) {
        await ctx.answerCallbackQuery("❌ Gemini не настроен", { show_alert: true });
        await ctx.editMessageText(`❌ <b>Gemini не настроен!</b>

Для использования Gemini добавьте API ключ.

📝 <b>Как получить:</b>
1. Зайдите на https://aistudio.google.com
2. Получите бесплатный API ключ
3. Добавьте в .env: GEMINI_API_KEY=ваш_ключ

⚠️ Пока используйте <b>GPT-4o</b> (требуется OPENAI_API_KEY)`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 Использовать GPT-4o", callback_data: "model_gpt" }],
              [{ text: "🔙 Главное меню", callback_data: "back_to_start" }]
            ]
          }
        });
        return;
      }
      session.model = "Gemini";
      userSessions.set(ctx.from.id, session);
      await ctx.answerCallbackQuery("✅ Gemini 2.0 выбран!");
      await ctx.editMessageText(`✅ <b>Модель изменена!</b>

✨ <b>Gemini 2.0</b> выбран как активная модель.

Напишите сообщение для начала чата!`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Чат с Gemini", callback_data: "model_gemini" },
              { text: "⚙️ Настройки", callback_data: "settings" }
            ],
            [
              { text: "🔙 Главное меню", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "settings":
      await ctx.answerCallbackQuery("⚙️ Настройки");
      const settings = `
<b>⚙️ Выберите модель</b>

<b>Текущая:</b> ${session.model}
      `;
      await ctx.editMessageText(settings, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude 3.5", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini 2.0", callback_data: "model_gemini" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "help":
      await ctx.answerCallbackQuery("📖 Помощь");
      const help = `
<b>📖 Справка по Geniok AI</b>

<b>AI Модели:</b>
• GPT-4o - Универсальный, быстрый
• Claude 3.5 - Лучший для кода и анализа
• Gemini 2.0 - Google's AI

<b>Как использовать:</b>
Просто напишите вопрос боту!
      `;
      await ctx.editMessageText(help, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini", callback_data: "model_gemini" }
            ],
            [
              { text: "🔄 Сменить модель", callback_data: "settings" }
            ]
          ]
        }
      });
      break;
      
    case "back_to_start":
      await ctx.answerCallbackQuery("🏠 Главное меню");
      const welcomeBack = `
🤖 <b>Geniok AI</b>

ваш AI супер ассистент
      `;
      await ctx.editMessageText(welcomeBack, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 Чат", callback_data: "chat" },
              { text: "🎨 Изображения", callback_data: "image_gen" }
            ],
            [
              { text: "🎵 Музыка", callback_data: "music_gen" },
              { text: "🎬 Видео", callback_data: "video_gen" }
            ],
            [
              { text: "🎙️ Голос", callback_data: "voice" },
              { text: "📚 Документы", callback_data: "documents" }
            ],
            [
              { text: "📖 Помощь", callback_data: "help" },
              { text: "⚙️ Профиль", callback_data: "profile" }
            ]
          ]
        }
      });
      break;
      
    case "image_gen":
      await ctx.answerCallbackQuery("🎨 Генерация изображений");
      const imageHelp = `
🎨 <b>Генерация изображений</b>

<b>Использование:</b>
/imagine &lt;описание&gt;

<b>Примеры:</b>
/imagine красивый закат над океаном
/imagine котик в стиле аниме
/imagine логотип для стартапа

<b>Стили:</b>
• photorealistic • anime • digital art
• oil painting • 3d render • cartoon
      `;
      await ctx.editMessageText(imageHelp, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🌅 Пейзаж", callback_data: "img_landscape" },
              { text: "🐱 Животные", callback_data: "img_animals" }
            ],
            [
              { text: "🎨 Арт", callback_data: "img_art" },
              { text: "🖼️ Аниме", callback_data: "img_anime" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "img_landscape":
      await ctx.answerCallbackQuery("🌅 Пейзаж");
      await ctx.editMessageText(`
🌅 <b>Пейзажи</b>

Популярные описания:

• Горный пейзаж на закате
• Тропический пляж с пальмами
• Лес в тумане
• Озеро с отражением гор

<i>Используйте /imagine &lt;описание&gt;</i>
      `, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 К меню", callback_data: "image_gen" }]
          ]
        }
      });
      break;
      
    case "img_animals":
      await ctx.answerCallbackQuery("🐱 Животные");
      await ctx.editMessageText(`
🐱 <b>Животные</b>

Популярные описания:

• Милый котенок с большими глазами
• Белая собака хаски в снегу
• Пара лебедей на озере
• Лев на закате

<i>Используйте /imagine &lt;описание&gt;</i>
      `, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 К меню", callback_data: "image_gen" }]
          ]
        }
      });
      break;
      
    case "img_art":
      await ctx.answerCallbackQuery("🎨 Арт");
      await ctx.editMessageText(`
🎨 <b>Арт</b>

Популярные описания:

• Портрет в стиле Пикассо
• Абстракция с яркими цветами
• Граффити на стене
• Цифровой арт в стиле Pixar

<i>Используйте /imagine &lt;описание&gt;</i>
      `, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 К меню", callback_data: "image_gen" }]
          ]
        }
      });
      break;
      
    case "img_anime":
      await ctx.answerCallbackQuery("🖼️ Аниме");
      await ctx.editMessageText(`
🖼️ <b>Аниме</b>

Популярные описания:

• Девочка в школьной форме
• Красивый закат в аниме стиле
• Фэнтези персонаж с мечом
• Кавайный кот

<i>Используйте /imagine &lt;описание&gt;</i>
      `, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 К меню", callback_data: "image_gen" }]
          ]
        }
      });
      break;
      
    case "music_gen":
      await ctx.answerCallbackQuery("🎵 Генерация музыки");
      const musicHelp = `
🎵 <b>Генерация музыки</b>

<b>Использование:</b>
/music &lt;описание&gt;

<b>Примеры:</b>
/music relaxing ambient piano
/music energetic electronic dance
/music calm lofi hip hop
/music dramatic orchestral

<b>Стили:</b>
am • ambient • electronic • rock • jazz
lofi • hiphop • pop • folk • metal
piano • orchestral • chill • upbeat
      `;
      await ctx.editMessageText(musicHelp, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎹 Ambient", callback_data: "music_ambient" },
              { text: "🎸 Rock", callback_data: "music_rock" }
            ],
            [
              { text: "🎹 Lofi", callback_data: "music_lofi" },
              { text: "🎻 Classical", callback_data: "music_classical" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "music_ambient":
      await ctx.answerCallbackQuery("🎹 Ambient music");
      await ctx.replyWithChatAction("upload_document");
      const ambientMusic = await generateMusic("ambient relaxing chill nature sounds", ctx);
      if (ambientMusic) {
        await ctx.replyWithAudio(ambientMusic, {
          caption: `🎹 <b>Ambient Music</b>

Стиль: Relaxing ambient

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "music_rock":
      await ctx.answerCallbackQuery("🎸 Rock music");
      await ctx.replyWithChatAction("upload_document");
      const rockMusic = await generateMusic("energetic rock guitar drums", ctx);
      if (rockMusic) {
        await ctx.replyWithAudio(rockMusic, {
          caption: `🎸 <b>Rock Music</b>

Стиль: Energetic rock

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "music_lofi":
      await ctx.answerCallbackQuery("🎹 Lofi music");
      await ctx.replyWithChatAction("upload_document");
      const lofiMusic = await generateMusic("lofi hip hop chill beats", ctx);
      if (lofiMusic) {
        await ctx.replyWithAudio(lofiMusic, {
          caption: `🎹 <b>Lofi Music</b>

Стиль: Chill lofi beats

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "music_classical":
      await ctx.answerCallbackQuery("🎻 Classical music");
      await ctx.replyWithChatAction("upload_document");
      const classicalMusic = await generateMusic("classical orchestral symphony piano", ctx);
      if (classicalMusic) {
        await ctx.replyWithAudio(classicalMusic, {
          caption: `🎻 <b>Classical Music</b>

Стиль: Orchestral symphony

/music &lt;описание&gt; - новая генерация`,
          parse_mode: "HTML"
        });
      } else {
        await ctx.reply("❌ Генерация недоступна. Попробуйте позже.");
      }
      break;
      
    case "retry":
      await ctx.answerCallbackQuery("🔄 Попробуйте отправить сообщение ещё раз");
      break;
      
      await ctx.answerCallbackQuery("💬 Выберите модель");
      await ctx.editMessageText(`💬 <b>Выберите AI модель</b>

Напишите сообщение боту или выберите модель:`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 GPT-4o", callback_data: "model_gpt" },
              { text: "🧠 Claude", callback_data: "model_claude" }
            ],
            [
              { text: "✨ Gemini", callback_data: "model_gemini" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "video_gen":
      await ctx.answerCallbackQuery("🎬 Видео");
      await ctx.editMessageText(`🎬 <b>Генерация видео</b>

<b>Доступно скоро!</b>

Скоро здесь будет генерация видео с помощью AI.

🎬 Поддерживаемые форматы:
• Текст в видео
• Изображение в видео
• Анимация

⏳ Ожидайте обновление...`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎨 Изображения", callback_data: "image_gen" },
              { text: "🎵 Музыка", callback_data: "music_gen" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "voice":
      await ctx.answerCallbackQuery("🎙️ Голос");
      await ctx.editMessageText(`🎙️ <b>Голос и синтез речи</b>

<b>Доступно скоро!</b>

Скоро здесь будет:
• Синтез речи (TTS)
• Клонирование голоса
• Озвучка текста

⏳ Ожидайте обновление...`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎨 Изображения", callback_data: "image_gen" },
              { text: "🎵 Музыка", callback_data: "music_gen" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "documents":
      await ctx.answerCallbackQuery("📚 Документы");
      await ctx.editMessageText(`📚 <b>Документы</b>

<b>Доступные функции:</b>

• Создание документов
• Редактирование PDF
• Анализ документов
• Перевод документов

📝 Просто отправьте документ боту!`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 Чат", callback_data: "chat" },
              { text: "🎨 Изображения", callback_data: "image_gen" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "profile":
      await ctx.answerCallbackQuery("⚙️ Профиль");
      const session = userSessions.get(ctx.from.id) || { model: "GPT-4o" };
      await ctx.editMessageText(`⚙️ <b>Профиль</b>

👤 <b>Пользователь:</b> ${ctx.from.first_name}
🆔 <b>ID:</b> ${ctx.from.id}

📊 <b>Настройки:</b>
• Активная модель: ${session.model}
• Статус: Активен

💳 <b>Подписка:</b>
• Тариф: Базовый
• Доступно запросов: ∞

🎁 Хотите больше возможностей?`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💳 Тарифы", callback_data: "tariffs" },
              { text: "⚙️ Настройки", callback_data: "settings" }
            ],
            [
              { text: "🔙 Назад", callback_data: "back_to_start" }
            ]
          ]
        }
      });
      break;
      
    case "tariffs":
      await ctx.answerCallbackQuery("💳 Тарифы");
      await ctx.editMessageText(`💳 <b>Тарифы</b>

🆓 <b>Бесплатный:</b>
• 100 запросов/день
• GPT-4o mini
• Базовая генерация

⭐ <b>Про (299₽/мес):</b>
• 1000 запросов/день
• GPT-4o, Claude, Gemini
• Генерация изображений

💎 <b>Максимум (999₽/мес):</b>
• Безлимит запросов
• Все модели
• Видео, музыка, голос
• Приоритетная поддержка`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Купить Про", callback_data: "buy_pro" }],
            [{ text: "🔙 Назад", callback_data: "profile" }]
          ]
        }
      });
      break;

    default:
      await ctx.answerCallbackQuery("Неизвестная команда");
  }
});
