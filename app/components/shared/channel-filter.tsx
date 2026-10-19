"use client";

import { useEffect, useState } from "react";
import { getChannels } from "@/app/lib/api";
import type { ChannelConnection } from "@/shared/channels";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";

export function ChannelFilter({value,onValueChange}: {value:string;onValueChange(value:string):void}) {
  const [channels,setChannels]=useState<ChannelConnection[]>([]);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;void getChannels().then(items=>{if(active)setChannels(items);}).catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[]);
  return <div className="min-w-0"><Select value={value} onValueChange={onValueChange}><SelectTrigger aria-label="Filtrar por canal" className="w-full sm:min-w-44"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">Todos os canais</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem>{channels.map(channel=><SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}</SelectContent></Select>{failed?<p className="mt-1 text-xs text-muted-foreground">Não foi possível carregar os canais adicionais.</p>:null}</div>;
}
