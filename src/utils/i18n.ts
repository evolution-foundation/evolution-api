import { ConfigService, Language } from '@config/env.config';
import fs from 'fs';
import i18next from 'i18next';
import path from 'path';

const translationsPath = path.join(__dirname, 'translations');
const languages = fs
  .readdirSync(translationsPath)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));
const configService: ConfigService = new ConfigService();

const resources: any = {};

languages.forEach((language) => {
  const languagePath = path.join(translationsPath, `${language}.json`);
  if (fs.existsSync(languagePath)) {
    const translationContent = fs.readFileSync(languagePath, 'utf8');
    resources[language] = {
      translation: JSON.parse(translationContent),
    };
  }
});

i18next.init({
  resources,
  fallbackLng: 'en',
  lng: configService.get<Language>('LANGUAGE'),
  debug: false,

  interpolation: {
    escapeValue: false,
  },
});
export default i18next;
