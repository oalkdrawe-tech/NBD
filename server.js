require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const required = ['SESSION_SECRET','META_APP_ID','META_APP_SECRET','META_REDIRECT_URI','META_API_VERSION'];
app.use(express.json());
app.use(session({
  name: 'nabd.sid', secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
const configured = () => required.every(k => process.env[k] && !String(process.env[k]).includes('YOUR-') && !String(process.env[k]).includes('your_') && !String(process.env[k]).includes('vXX'));
const graph = () => `https://graph.instagram.com/${process.env.META_API_VERSION}`;
async function apiGet(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error?.message || `Instagram API error (${r.status})`);
  return data;
}
app.get('/api/status', (req,res) => res.json({configured: configured(), connected: !!req.session.ig, account: req.session.ig?.profile || null}));
app.get('/auth/instagram', (req,res) => {
  if (!configured()) return res.status(503).send('لم يكتمل إعداد Meta بعد. اتبع README وأضف متغيرات البيئة أولًا.');
  const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state;
  const scope = ['instagram_business_basic','instagram_business_manage_comments','instagram_business_manage_insights'].join(',');
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({client_id:process.env.META_APP_ID, redirect_uri:process.env.META_REDIRECT_URI, response_type:'code', scope, state, enable_fb_login:'0', force_authentication:'1'}).toString();
  res.redirect(url.toString());
});
app.get('/auth/instagram/callback', async (req,res) => {
  try {
    if (req.query.error) return res.status(400).send('تم إلغاء تسجيل الدخول أو رفضت الصلاحيات. يمكنك العودة للموقع والمحاولة مجددًا.');
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('تعذر التحقق من تسجيل الدخول. ارجع للموقع وحاول مرة أخرى.');
    delete req.session.oauthState;
    const form = new URLSearchParams({client_id:process.env.META_APP_ID, client_secret:process.env.META_APP_SECRET, grant_type:'authorization_code', redirect_uri:process.env.META_REDIRECT_URI, code:String(req.query.code)});
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});
    const token = await tokenRes.json();
    if (!tokenRes.ok || token.error_message || !token.access_token) throw new Error(token.error_message || 'تعذر الحصول على رمز الوصول.');
    let accessToken = token.access_token;
    // Try exchanging for a long-lived token; if unavailable, keep the short-lived token for this session.
    try {
      const long = await apiGet(`${graph()}/access_token?${new URLSearchParams({grant_type:'ig_exchange_token',client_secret:process.env.META_APP_SECRET,access_token:accessToken})}`);
      if (long.access_token) accessToken = long.access_token;
    } catch (_) {}
    const profile = await apiGet(`${graph()}/me?${new URLSearchParams({fields:'user_id,username,account_type,media_count,followers_count,follows_count',access_token:accessToken})}`);
    req.session.ig = {accessToken, profile, connectedAt:Date.now()};
    res.redirect('/?connected=1');
  } catch (e) { console.error('Instagram OAuth:', e.message); res.status(500).send('فشل الربط: '+e.message+' — تأكد من إعداد تطبيق Meta والصلاحيات ورابط العودة.'); }
});
app.post('/api/disconnect',(req,res)=>{delete req.session.ig; res.json({ok:true});});
app.get('/api/profile', async (req,res)=>{
  if (!req.session.ig) return res.status(401).json({error:'اربط حساب إنستغرام أولًا.'});
  try { const p=await apiGet(`${graph()}/me?${new URLSearchParams({fields:'user_id,username,account_type,media_count,followers_count,follows_count',access_token:req.session.ig.accessToken})}`); req.session.ig.profile=p; res.json(p); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get('/api/media', async(req,res)=>{
  if(!req.session.ig) return res.status(401).json({error:'اربط حساب إنستغرام أولًا.'});
  try { const data=await apiGet(`${graph()}/me/media?${new URLSearchParams({fields:'id,caption,media_type,permalink,timestamp,like_count,comments_count',limit:'12',access_token:req.session.ig.accessToken})}`); res.json(data); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get('/api/comments/:mediaId', async(req,res)=>{
  if(!req.session.ig) return res.status(401).json({error:'اربط حساب إنستغرام أولًا.'});
  try { const data=await apiGet(`${graph()}/${encodeURIComponent(req.params.mediaId)}/comments?${new URLSearchParams({fields:'id,text,timestamp,username',limit:'50',access_token:req.session.ig.accessToken})}`); res.json(data); }
  catch(e){res.status(502).json({error:e.message});}
});
app.post('/api/comments/:commentId/reply', async(req,res)=>{
  if(!req.session.ig) return res.status(401).json({error:'اربط حساب إنستغرام أولًا.'});
  const message=String(req.body?.message||'').trim(); if(!message || message.length>2000) return res.status(400).json({error:'اكتب ردًا من 1 إلى 2000 حرف.'});
  try { const body=new URLSearchParams({message,access_token:req.session.ig.accessToken}); const r=await fetch(`${graph()}/${encodeURIComponent(req.params.commentId)}/replies`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}); const data=await r.json().catch(()=>({})); if(!r.ok||data.error) throw new Error(data.error?.message||'تعذر إرسال الرد'); res.json(data); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get('/health',(req,res)=>res.json({ok:true,service:'NABD PLUS'}));
app.listen(PORT,'0.0.0.0',()=>console.log(`NABD PLUS listening on ${PORT}`));
