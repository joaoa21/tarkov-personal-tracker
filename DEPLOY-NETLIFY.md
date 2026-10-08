# Deploy no Netlify — Tarkov Personal Tracker V0.13.0

O projeto usa Next.js App Router e Route Handlers. O Netlify detecta Next.js automaticamente, então não é necessário instalar ou fixar manualmente o adapter/plugin do Next.js.

## Antes de sair do localhost

1. Abra **Perfil → Backup do progresso**.
2. Clique em **Exportar backup** e guarde o JSON.
3. Depois do deploy, abra o endereço do Netlify.
4. Vá a **Perfil → Importar backup** e selecione o mesmo JSON.

O backup inclui PvE, PvP e Season em um único arquivo.

## Deploy recomendado via GitHub

1. Crie um repositório GitHub e envie o conteúdo desta pasta.
2. No Netlify, escolha **Add new project → Import an existing project**.
3. Conecte o GitHub e selecione o repositório.
4. O framework deve ser detectado como **Next.js**.
5. Build command: `npm run build` (equivalente a `next build`).
6. Publish directory: `.next`.
7. Faça o deploy.

As rotas em `app/api/...` são Route Handlers do Next.js e são executadas pelo runtime do Netlify.

## Desenvolvimento local

```bash
npm install
npm run dev
```
