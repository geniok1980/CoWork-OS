# 🤖 Syntax AI Telegram Bot

**AI Super App в Вашем кармане!**

Генерируйте текст, изображения, видео. Общайтесь с ChatGPT, Claude, Gemini и другими AI моделями через Telegram.

## 🚀 Быстрый старт

### 1. Получите Telegram токен

1. Откройте Telegram → найдите **@BotFather**
2. Отправьте `/newbot`
3. Введите имя бота (например: `Syntax AI`)
4. Введите username бота (например: `syntax_ai_bot`)
5. **Скопируйте токен** (выглядит так: `123456789:ABCdefGHIjklMNOpqrSTUvwxyz`)

### 2. Установите зависимости

```bash
cd syntax-bot
npm install
```

### 3. Настройте переменные окружения

```bash
cp .env.example .env
```

Откройте `.env` и добавьте ваши API ключи:

```env
TELEGRAM_BOT_TOKEN=your_telegram_token
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GEMINI_API_KEY=your_gemini_key
```

### 4. Запустите бота

```bash
npm start
```

## 📱 Доступные команды

| Команда | Описание |
|---------|---------|
| `/start` | Приветствие |
| `/help` | Справка |
| `/chat` | Переключить на GPT-4o |
| `/claude` | Переключить на Claude 3.5 |
| `/gemini` | Переключить на Gemini 2.0 |
| `/model` | Показать текущую модель |
| `/settings` | Настройки |

## 💡 Использование

Просто напишите сообщение боту и получите ответ от AI!

**Примеры:**
- "Напиши код на Python для парсинга сайта"
- "Объясни квантовую механику простыми словами"
- "Помоги написать пост для Instagram"

## 🔧 AI Провайдеры

### OpenAI (GPT-4o)
- Быстрые ответы
- Отличное качество
- Получить ключ: https://platform.openai.com/api-keys

### Anthropic (Claude 3.5)
- Лучший для анализа и кода
- Длинный контекст
- Получить ключ: https://console.anthropic.com/

### Google (Gemini 2.0)
- Бесплатный tier
- Быстрая генерация
- Получить ключ: https://aistudio.google.com/

## 🛠️ Разработка

### Структура проекта

```
syntax-bot/
├── src/
│   └── index.js          # Основной код бота
├── .env.example          # Пример переменных окружения
├── package.json
└── README.md
```

### Добавление новых команд

```javascript
// В src/index.js
bot.command("yourcommand", async (ctx) => {
  await ctx.reply("Ваш ответ!");
});
```

## 📦 Будущие функции

- [ ] 🖼️ Генерация изображений (DALL-E, Midjourney, Flux)
- [ ] 🎬 Генерация видео (Runway, Kling, Sora)
- [ ] 🎙️ Клонирование голоса
- [ ] 🎵 Генерация музыки
- [ ] 💳 WATA платежи

## 💰 Монетизация (WATA)

Планируемые тарифы:

| Тариф | Цена | Функции |
|-------|------|---------|
| Free | 0₽ | 10 запросов/день |
| Basic | 299₽/мес | 100 запросов/день |
| Pro | 799₽/мес | Безлимит |
| Enterprise | 2999₽/мес | API доступ |

## 🌐 Деплой

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD ["npm", "start"]
```

### Systemd service

```ini
[Unit]
Description=Syntax AI Bot
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/syntax-bot
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 📄 Лицензия

MIT License

## 🤝 Контакты

- Telegram: @syntax_ai_bot
- GitHub: https://github.com/geniok1980/CoWork-OS

---

**Made with ❤️ for AI enthusiasts**
