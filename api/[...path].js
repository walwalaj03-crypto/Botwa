const {neon}=require('@neondatabase/serverless');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const crypto=require('crypto');

const plans=[
 {id:'p1',name:'7 Hari',days:7,price:4000},
 {id:'p2',name:'15 Hari',days:15,price:10000},
 {id:'p3',name:'30 Hari',days:30,price:18000},
 {id:'p4',name:'60 Hari',days:60,price:30000},
 {id:'p5',name:'90 Hari',days:90,price:45000}
];
const sql=()=>{if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL belum diatur');return neon(process.env.DATABASE_URL)};
const now=()=>Date.now();
function send(res,status,obj){res.status(status).json(obj)}
function getCookie(req,name){const s=req.headers.cookie||'';for(const part of s.split(';')){const [k,...v]=part.trim().split('=');if(k===name)return decodeURIComponent(v.join('='))}return null}
function setCookie(res,value){res.setHeader('Set-Cookie',`hb_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`)}
function clearCookie(res){res.setHeader('Set-Cookie','hb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')}
function token(req){try{return jwt.verify(getCookie(req,'hb_session'),process.env.JWT_SECRET)}catch{return null}}
function makeToken(user){return jwt.sign({id:user.id,email:user.email,username:user.username,owner:!!user.owner},process.env.JWT_SECRET,{expiresIn:'7d'})}
function body(req){return new Promise((resolve,reject)=>{if(req.body&&typeof req.body==='object')return resolve(req.body);let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{try{if((req.headers['content-type']||'').includes('application/x-www-form-urlencoded'))resolve(Object.fromEntries(new URLSearchParams(raw)));else resolve(raw?JSON.parse(raw):{})}catch(e){reject(e)}});req.on('error',reject)})}
function requireAuth(u){return !!u}
function requireOwner(u){return !!u&&u.owner}
async function buatQrisRequest(fields){
 const account=process.env.BUATQRIS_ACCOUNT_ID, secret=process.env.BUATQRIS_SECRET_TOKEN;
 if(!account||!secret)throw new Error('BuatQRIS belum dikonfigurasi di Environment Variables');
 const params=new URLSearchParams({action:fields.action,account_id:account,secret_token:secret,...fields.params});
 const base=(process.env.BUATQRIS_BASE_URL||'https://api.buatqris.site').replace(/\/$/,'');
 const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params});
 const data=await response.json().catch(()=>({}));
 if(response.status===429){const err=new Error(data.message||'Terlalu sering cek status QRIS');err.status=429;err.retryAfter=Number(data.retry_after||14);throw err;}
 if(!response.ok||data.success!==true)throw new Error(data.message||data.error||'BuatQRIS gagal memproses permintaan');
 return data.data||{};
}
async function createQris(amount,description){
 const d=await buatQrisRequest({action:'api_create_qris',params:{amount:String(amount),description,qris_method:process.env.BUATQRIS_METHOD||'qris_two',fee_by:process.env.BUATQRIS_FEE_BY||'user'}});
 if(!d.transaction_id)throw new Error('ID transaksi tidak ada pada respons BuatQRIS');
 const qr=d.qr_url||d.qris_image||null;
 const url=d.payment_url||d.qr_url||null;
 if(!url&&!qr)throw new Error('QR atau URL pembayaran tidak ada pada respons BuatQRIS');
 return {transactionId:String(d.transaction_id),qrUrl:qr,paymentUrl:url,totalAmount:Number(d.total_amount||amount),amount:Number(d.amount||amount),status:String(d.status||'pending')};
}
async function createPayment(u,amount,kind,days){
 const id=crypto.randomUUID(),ref='HB-'+id.replace(/-/g,'');
 const q=await createQris(amount,kind==='plan'?'HendarBot paket '+days+' hari':kind==='owner_test'?'HendarBot TEST QRIS':'Deposit HendarBot');
 await sql()`INSERT INTO payments(id,user_id,reference_id,provider_transaction_id,amount,kind,plan_days,status,checkout_url,created_at) VALUES(${id},${u.id},${ref},${q.transactionId},${amount},${kind},${days||null},'pending',${q.paymentUrl},${now()})`;
 return {id,referenceId:ref,transactionId:q.transactionId,amount,totalAmount:q.totalAmount,url:q.paymentUrl,qrUrl:q.qrUrl,status:'pending'};
}
async function applyPaymentSuccess(row){
 const changed=await sql()`UPDATE payments SET status='paid',paid_at=${now()} WHERE id=${row.id} AND status='pending' RETURNING id`;
 if(!changed.length)return;
 if(row.kind==='deposit')await sql()`UPDATE users SET balance=balance+${row.amount} WHERE id=${row.user_id}`;
 if(row.kind==='plan')await sql()`UPDATE users SET premium_until=GREATEST(premium_until,${now()})+${row.plan_days*86400000} WHERE id=${row.user_id}`;
}
module.exports=async function handler(req,res){
try{
 const parts=(req.query.path||[]);const route=Array.isArray(parts)?parts.join('/'):String(parts||'');const method=req.method;
 const b=await body(req);const u=token(req);
 if(method==='GET'&&route==='config')return send(res,200,{auth:'email-password',qrisProvider:'BuatQRIS'});
 if(method==='GET'&&route==='me'){if(!u)return send(res,200,{user:null});if(u.owner)return send(res,200,{user:u});const rows=await sql()`SELECT premium_until,balance FROM users WHERE id=${u.id}`;return send(res,200,{user:{...u,premiumUntil:rows[0]?.premium_until||0,balance:rows[0]?.balance||0}})}
 if(method==='POST'&&route==='register'){const email=String(b.email||'').trim().toLowerCase(),username=String(b.username||'').trim(),password=String(b.password||'');if(!email||!username||password.length<8)return send(res,400,{error:'Isi semua data. Password minimal 8 karakter.'});const id=crypto.randomUUID(),hash=await bcrypt.hash(password,12);try{await sql()`INSERT INTO users(id,email,username,password_hash,created_at) VALUES(${id},${email},${username},${hash},${now()})`}catch{return send(res,409,{error:'Email sudah terdaftar'})}const t=makeToken({id,email,username});setCookie(res,t);return send(res,200,{ok:true,user:{id,email,username}})}
 if(method==='POST'&&route==='login'){const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(email===(process.env.OWNER_EMAIL||'').toLowerCase()&&process.env.OWNER_PASSWORD_HASH&&await bcrypt.compare(password,process.env.OWNER_PASSWORD_HASH)){const t=makeToken({id:'owner',email,username:'Owner',owner:true});setCookie(res,t);return send(res,200,{ok:true,user:{id:'owner',email,username:'Owner',owner:true}})}const rows=await sql()`SELECT id,email,username,password_hash FROM users WHERE email=${email} LIMIT 1`;const x=rows[0];if(!x||!x.password_hash||!await bcrypt.compare(password,x.password_hash))return send(res,401,{error:'Email atau password salah'});setCookie(res,makeToken(x));return send(res,200,{ok:true,user:{id:x.id,email:x.email,username:x.username}})}
 if(method==='POST'&&route==='logout'){clearCookie(res);return send(res,200,{ok:true})}

 if(method==='GET'&&route==='plans')return send(res,200,plans);
 if(method==='POST'&&route==='trial'){if(!requireAuth(u)||u.owner)return send(res,401,{error:'Login sebagai user'});const rows=await sql()`UPDATE users SET trial_used=TRUE,premium_until=${now()+2*86400000} WHERE id=${u.id} AND trial_used=FALSE RETURNING id`;if(!rows.length)return send(res,400,{error:'Trial hanya bisa dipakai satu kali'});return send(res,200,{ok:true,message:'Free Trial aktif 2 hari'})}
 if(method==='POST'&&route==='pairing'){if(!requireAuth(u))return send(res,401,{error:'Silakan login'});const phone=String(b.number||'').replace(/\D/g,'');if(phone.length<9||phone.length>15)return send(res,400,{error:'Nomor tidak valid'});await sql()`INSERT INTO pairings(id,user_id,email,phone,created_at) VALUES(${crypto.randomUUID()},${u.id},${u.email},${phone},${now()})`;return send(res,200,{ok:true,message:'Permintaan masuk antrean owner. Kode pairing butuh integrasi source bot WhatsApp.'})}
 if(method==='POST'&&route==='deposit'){if(!requireAuth(u))return send(res,401,{error:'Silakan login'});const amount=Number(b.amount);if(!Number.isInteger(amount)||amount<5000)return send(res,400,{error:'Minimal deposit Rp5.000'});const p=await createPayment(u,amount,'deposit');return send(res,200,{ok:true,payment:p})}
 if(method==='POST'&&route==='buy'){if(!requireAuth(u))return send(res,401,{error:'Silakan login'});const plan=plans.find(x=>x.id===b.planId);if(!plan)return send(res,400,{error:'Paket tidak ditemukan'});const p=await createPayment(u,plan.price,'plan',plan.days);return send(res,200,{ok:true,payment:p})}
 if(method==='GET'&&route.startsWith('payment/')){if(!requireAuth(u))return send(res,401,{error:'Silakan login'});const id=route.split('/')[1];const rows=await sql()`SELECT id,status,amount,kind,provider_transaction_id FROM payments WHERE id=${id} AND user_id=${u.id} LIMIT 1`;if(!rows.length)return send(res,404,{error:'Pembayaran tidak ditemukan'});const row=rows[0];if(row.status==='pending'){const d=await buatQrisRequest({action:'api_check_status',params:{transaction_id:String(row.provider_transaction_id)}});const st=String(d.status||'pending').toLowerCase();if(st==='success')await applyPaymentSuccess(row);else if(st==='expired'||st==='failed')await sql()`UPDATE payments SET status=${st} WHERE id=${row.id} AND status='pending'`;const latest=await sql()`SELECT status,amount,kind FROM payments WHERE id=${id} LIMIT 1`;return send(res,200,latest[0]||row)}return send(res,200,{status:row.status,amount:row.amount,kind:row.kind})}
 if(method==='POST'&&route==='feature-check'){if(!requireAuth(u))return send(res,401,{error:'Silakan login'});if(u.owner)return send(res,200,{allowed:true});const rows=await sql()`SELECT premium_until FROM users WHERE id=${u.id}`;const allowed=Number(rows[0]?.premium_until||0)>now();return send(res,200,{allowed,message:allowed?'Buyer':'Only Buyer/owner'})}

 if(route==='owner/queue'&&method==='GET'){if(!requireOwner(u))return send(res,403,{error:'Khusus owner'});const [users,payments,pairings]=await Promise.all([sql()`SELECT id,email,username,trial_used,premium_until,balance,created_at FROM users ORDER BY created_at DESC LIMIT 100`,sql()`SELECT id,user_id,reference_id,amount,kind,status,created_at FROM payments ORDER BY created_at DESC LIMIT 100`,sql()`SELECT id,email,phone,status,created_at FROM pairings ORDER BY created_at DESC LIMIT 100`]);return send(res,200,{users,payments,pairings})}
 if(route==='owner/pairing'&&method==='POST'){if(!requireOwner(u))return send(res,403,{error:'Khusus owner'});const phone=String(b.number||'').replace(/\D/g,'');if(phone.length<9)return send(res,400,{error:'Nomor tidak valid'});await sql()`INSERT INTO pairings(id,user_id,email,phone,status,created_at) VALUES(${crypto.randomUUID()},'owner','owner',${phone},'owner-request',${now()})`;return send(res,200,{ok:true,message:'Permintaan dicatat; pairing asli perlu integrasi bot utama'})}
 if(route==='owner/test-qris'&&method==='POST'){if(!requireOwner(u))return send(res,403,{error:'Khusus owner'});const amount=Number(b.amount);if(!Number.isInteger(amount)||amount<5000)return send(res,400,{error:'Minimal Rp5.000'});const p=await createPayment(u,amount,'owner_test');return send(res,200,{ok:true,payment:p})}
 return send(res,404,{error:'Endpoint tidak ditemukan'});
}catch(e){console.error('HendarBot API error:',e.message);if(e.status===429)return send(res,429,{error:e.message,retry_after:e.retryAfter||14});return send(res,500,{error:e.message||'Server error. Periksa Environment Variables dan database.'})}
};
