export type Cue = {start:number; end:number; text:string};
export type Edit = {
  start:number; end:number;
  subtitles:{track_id:string; burn:boolean; preserve_ass:boolean; font:string; size:number; color:string; outline_color:string; outline:number; shadow:number; box:boolean; box_opacity:number; position:string; align:string; margin:number; offset:number};
  crop:{ratio:string; mode:string; x:number; y:number};
  watermark:{kind:string; text:string; asset_id:string; x:number; y:number; size:number; width:number; opacity:number; margin:number; color:string; font:string; start:number; end:number|null};
  audio:{track:number; mute:boolean; volume:number; music_id:string; music_volume:number; fade_in:number; fade_out:number};
  resolution:number; fps:number; quality:string; filename:string;
};
export type Metadata = {duration:number; width:number; height:number; size:number; video_codec:string; audio:{index:number; codec:string; language:string; title:string}[]; subtitles:unknown[]};
export type Project = {id:string; name:string; status:string; created:number; metadata:Metadata; edit:Edit; has_source:boolean; has_preview:boolean; has_thumbnail:boolean; subtitles?:{id:string; title:string; language:string; codec:string; editable:number}[]; assets?:{id:string; kind:string; name:string}[]};
export type Job = {id:string; kind:string; project_id:string; status:string; progress:number; bytes:number; speed:number; error:string|null; created:number; elapsed:number; eta:number|null; result_id:string|null};
export type Clip = {id:string; project_id:string; name:string; metadata:Metadata; created:number; preview:boolean};
export type Settings = {telegram:{api_id:number|string; api_hash_saved:boolean; phone:string; destination:string}; telegram_status:{connected:boolean; name?:string; username?:string; step?:string; error?:string}; storage:{used:number; free:number; limit_gb:number; categories:Record<string,number>}};
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T> {
  const response=await fetch('/api'+path,{...options,headers:options.body instanceof FormData ? options.headers : {'Content-Type':'application/json',...options.headers}});
  if(!response.ok) {const error=await response.json().catch(()=>({detail:'The request failed. Try again.'})); throw new Error(typeof error.detail==='string'?error.detail:'Check your entries and try again.');}
  return response.json();
}
export const json=(method:string,body?:unknown)=>({method,body:body===undefined?undefined:JSON.stringify(body)});
export function size(bytes:number=0){ if(bytes<1024**2)return `${(bytes/1024).toFixed(0)} KB`; if(bytes<1024**3)return `${(bytes/1024**2).toFixed(1)} MB`; return `${(bytes/1024**3).toFixed(1)} GB`; }
export function clock(seconds:number=0){const s=Math.max(0,seconds); return `${Math.floor(s/3600)?Math.floor(s/3600)+':':''}${String(Math.floor(s/60)%60).padStart(2,'0')}:${(s%60).toFixed(1).padStart(4,'0')}`;}
export const fonts=['DejaVu Sans','DejaVu Serif','Liberation Sans','Liberation Serif','Noto Sans Arabic'];
