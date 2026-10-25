import { ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

export function ProtectedRoute({ 
  children, 
  adminOnly = false 
}: { 
  children: ReactNode;
  adminOnly?: boolean;
}) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading) {
      if (!user) {
        setLocation("/login");
      } else if (adminOnly && user.role !== "admin") {
        setLocation("/dashboard");
      }
    }
  }, [isLoading, user, adminOnly, setLocation]);

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user || (adminOnly && user.role !== "admin")) {
    return null; // Will redirect in useEffect
  }

  return <>{children}</>;
}
